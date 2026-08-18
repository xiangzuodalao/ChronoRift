import { createHash } from "node:crypto";

import {
  JsonValueSchema,
  Sha256DigestV1Schema,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { z } from "zod";

import {
  M7R3CaseCampaignAdmissionV1Schema,
  type M7R3CaseCampaignAdmissionV1,
} from "./m7-r3-case-admission.js";
import {
  M7R3CaseConstructionReceiptV1Schema,
  M7R3CasePreflightReceiptV1Schema,
  M7R3PortfolioCaseConstructionProjectionV1Schema,
  M7R3TrajectoryClassifierFreezeV1Schema,
  projectM7R3ClassifierFreezeToPortfolioV1,
  type M7R3CaseConstructionReceiptV1,
  type M7R3CasePreflightReceiptV1,
  type M7R3TrajectoryClassifierFreezeV1,
} from "./m7-r3-case-construction.js";
import {
  M7R3PairedCaseContractV1Schema,
  type M7R3PairedCaseContractV1,
} from "./m7-r3-paired-agent.js";
import {
  M7R3StoredDeliveryTraceV1Schema,
  type M7R3HiddenEvaluatorPortV1,
  type M7R3RuntimeUseLocalEvidenceStoreV1,
  type M7R3RuntimeUsePairedArmPortV1,
  runM7R3RuntimeUseLocalCampaignGateV1,
} from "./m7-r3-runtime-use-local-gate.js";
import { M7R3PatrolTrajectoryUseEvidenceV1Schema } from "./m7-patrol-trajectory.js";
import {
  M7CampaignTerminalRecordV1Schema,
  M7MutationPreflightReceiptV1Schema,
  M7MutationRegistrationV1Schema,
  type M7CampaignTerminalRecordV1,
  type M7RuntimeUseCampaignStoreV1,
} from "./m7-runtime-use-campaign.js";
import {
  M7R3PortfolioCaseReferenceV1Schema,
  M7R3TwoCasePortfolioFreezeV1Schema,
  M7R3TwoCasePortfolioSummaryV1Schema,
  createM7R3TwoCasePortfolioFreezeV1,
  type CreateM7R3TwoCasePortfolioFreezeV1Input,
  type M7R3PortfolioCaseReferenceV1,
  type M7R3TwoCasePortfolioFreezeV1,
  type M7R3TwoCasePortfolioStoreV1,
  type M7R3TwoCasePortfolioSummaryV1,
  type RecordM7R3PortfolioCaseOnceV1Input,
} from "./m7-r3-two-case-portfolio.js";

const sameJson = (left: unknown, right: unknown): boolean =>
  canonicalJson(JsonValueSchema.parse(left)) ===
  canonicalJson(JsonValueSchema.parse(right));

const digestJson = (value: unknown): Sha256DigestV1 =>
  Sha256DigestV1Schema.parse(
    createHash("sha256")
      .update(canonicalJson(JsonValueSchema.parse(value)), "utf8")
      .digest("hex"),
  );

const errorClassSha256 = (error: unknown): Sha256DigestV1 => {
  let errorClass: string = typeof error;
  try {
    if (error instanceof Error) {
      const prototype = Object.getPrototypeOf(error) as {
        constructor?: { name?: unknown };
      } | null;
      const constructorName = prototype?.constructor?.name;
      errorClass =
        typeof constructorName === "string" && constructorName.length > 0
          ? constructorName
          : "Error";
    }
  } catch {
    errorClass = "ErrorLike";
  }
  return Sha256DigestV1Schema.parse(
    createHash("sha256").update(errorClass, "utf8").digest("hex"),
  );
};

export const M7R3CampaignInfrastructureFailureStageV1Schema = z.enum([
  "case_contract_validation",
  "campaign_preparation",
  "prepared_campaign_validation",
  "campaign_gate",
  "terminal_evidence",
  "sandbox_safety_inspection",
  "residual_cleanup",
]);
export type M7R3CampaignInfrastructureFailureStageV1 = z.infer<
  typeof M7R3CampaignInfrastructureFailureStageV1Schema
>;

export const M7R3ResidualCleanupResultV1Schema = z
  .object({
    cleanupProven: z.boolean(),
    cleanupReceiptSha256: Sha256DigestV1Schema.nullable(),
    sandboxSafetyFailure: z.boolean(),
    sandboxSafetyReceiptSha256: Sha256DigestV1Schema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.cleanupProven !== (value.cleanupReceiptSha256 !== null)) {
      context.addIssue({
        code: "custom",
        path: ["cleanupReceiptSha256"],
        message: "cleanup proof and receipt presence must agree",
      });
    }
    if (
      value.sandboxSafetyFailure !==
      (value.sandboxSafetyReceiptSha256 !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sandboxSafetyReceiptSha256"],
        message: "sandbox-safety failure and receipt presence must agree",
      });
    }
  });
export type M7R3ResidualCleanupResultV1 = z.infer<
  typeof M7R3ResidualCleanupResultV1Schema
>;

const unprovenResidualCleanup = (): M7R3ResidualCleanupResultV1 => ({
  cleanupProven: false,
  cleanupReceiptSha256: null,
  sandboxSafetyFailure: false,
  sandboxSafetyReceiptSha256: null,
});

export type M7R3ResidualCleanupAttemptV1 =
  | Readonly<{
      outcome: "completed";
      cleanup: M7R3ResidualCleanupResultV1;
      error: null;
    }>
  | Readonly<{
      outcome: "failed";
      cleanup: M7R3ResidualCleanupResultV1;
      error: unknown;
    }>;

/**
 * One idempotent residual close after a Gate returns. This also closes an arm
 * that the Gate intentionally never started after an earlier cleanup failure.
 */
export async function attemptM7R3ResidualCampaignCleanupV1(
  cleanupRemaining: () => Promise<unknown>,
): Promise<M7R3ResidualCleanupAttemptV1> {
  try {
    return Object.freeze({
      outcome: "completed" as const,
      cleanup: M7R3ResidualCleanupResultV1Schema.parse(
        await cleanupRemaining(),
      ),
      error: null,
    });
  } catch (error) {
    return Object.freeze({
      outcome: "failed" as const,
      cleanup: unprovenResidualCleanup(),
      error,
    });
  }
}

export const M7R3CampaignInfrastructureFailureInputV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    portfolioId: M7R3TwoCasePortfolioFreezeV1Schema.shape.portfolioId,
    caseOrdinal: z.union([z.literal(1), z.literal(2)]),
    caseId: z.string().regex(/^m7-r3-case:[a-f0-9]{24}$/u),
    stage: M7R3CampaignInfrastructureFailureStageV1Schema,
    errorClassSha256: Sha256DigestV1Schema,
    agentStarted: z.boolean(),
    cleanupProven: z.boolean(),
    cleanupReceiptSha256: Sha256DigestV1Schema.nullable(),
    sandboxSafetyFailure: z.boolean(),
    sandboxSafetyReceiptSha256: Sha256DigestV1Schema.nullable(),
    campaignId: M7CampaignTerminalRecordV1Schema.shape.campaignId.nullable(),
    caseCampaignAdmissionRecordSha256: Sha256DigestV1Schema.nullable(),
    mutationRegistrationRecordSha256: Sha256DigestV1Schema.nullable(),
    observedTerminalRecordSha256: Sha256DigestV1Schema.nullable(),
    observedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    const cleanup = M7R3ResidualCleanupResultV1Schema.safeParse({
      cleanupProven: value.cleanupProven,
      cleanupReceiptSha256: value.cleanupReceiptSha256,
      sandboxSafetyFailure: value.sandboxSafetyFailure,
      sandboxSafetyReceiptSha256: value.sandboxSafetyReceiptSha256,
    });
    if (!cleanup.success) {
      cleanup.error.issues.forEach((issue) =>
        context.addIssue({
          code: "custom",
          path: [...issue.path],
          message: issue.message,
        }),
      );
    }
    if (
      value.campaignId === null &&
      (value.caseCampaignAdmissionRecordSha256 !== null ||
        value.mutationRegistrationRecordSha256 !== null ||
        value.observedTerminalRecordSha256 !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["campaignId"],
        message: "campaign ID is required for later campaign references",
      });
    }
  });
export type M7R3CampaignInfrastructureFailureInputV1 = z.infer<
  typeof M7R3CampaignInfrastructureFailureInputV1Schema
>;

const nullCampaignReferences = {
  campaignInfrastructureReceiptSha256: null,
  campaignId: null,
  caseCampaignAdmissionRecordSha256: null,
  mutationRegistrationRecordSha256: null,
  campaignTerminalRecordSha256: null,
  runtimeEnabledResultRecordSha256: null,
  codeOnlyResultRecordSha256: null,
  agentDeliveryTraceRecordSha256: null,
  trajectoryUseEvidenceRecordSha256: null,
} as const;

/**
 * The coordinator deliberately depends on the narrow create-once portfolio
 * surface. The concrete Host-only store implements this port, while offline
 * ordering tests do not need filesystem access.
 */
export interface M7R3TwoCaseLocalPortfolioStorePortV1 {
  readonly createPortfolioOnce: (
    input: CreateM7R3TwoCasePortfolioFreezeV1Input,
  ) => Promise<M7R3TwoCasePortfolioFreezeV1>;
  readonly recordCaseOnce: (
    input: RecordM7R3PortfolioCaseOnceV1Input,
  ) => Promise<M7R3PortfolioCaseReferenceV1>;
  readonly finalizeSummaryOnce: (
    summarizedAt: string,
  ) => Promise<M7R3TwoCasePortfolioSummaryV1>;
}

export interface M7R3PreparedLocalCaseCampaignV1 {
  /** Created after both no-Agent preflights, before the Gate starts Pi. */
  readonly caseAdmission: M7R3CaseCampaignAdmissionV1;
  readonly campaignStore: M7RuntimeUseCampaignStoreV1;
  readonly armPort: M7R3RuntimeUsePairedArmPortV1;
  readonly evaluatorPorts: Readonly<
    Record<"runtime_enabled" | "code_only", M7R3HiddenEvaluatorPortV1>
  >;
  readonly evidenceStore: M7R3RuntimeUseLocalEvidenceStoreV1;
  /** Idempotent Host cleanup for a failure before ordinary cleanup seals. */
  readonly cleanupRemainingAfterFailure: () => Promise<unknown>;
  readonly hasAgentStarted: () => boolean;
  readonly persistInfrastructureFailureOnce: (
    input: M7R3CampaignInfrastructureFailureInputV1,
  ) => Promise<Sha256DigestV1>;
  /**
   * Returns a retained sandbox-safety receipt hash, or null. Provider/model/
   * ordinary runner outcomes must return null. Cleanup safety is derived from
   * the campaign terminal itself and is not reported through this hook.
   */
  readonly readSandboxSafetyFailureReceiptAfterGate: (
    terminal: M7CampaignTerminalRecordV1,
  ) => Promise<Sha256DigestV1 | null>;
}

export interface M7R3TwoCaseLocalCasePlanV1<Ordinal extends 1 | 2> {
  readonly ordinal: Ordinal;
  readonly caseContract: unknown;
  /** Runs and persists public + hidden no-Agent preflight exactly once. */
  readonly runAndPersistPreflightOnce: (input: {
    readonly portfolioFreeze: M7R3TwoCasePortfolioFreezeV1;
    readonly constructionReceipt: M7R3CaseConstructionReceiptV1;
    readonly trajectoryClassifierFreeze: M7R3TrajectoryClassifierFreezeV1;
    readonly signal?: AbortSignal | undefined;
  }) => Promise<unknown>;
  /**
   * Materializes the admitted campaign and both prepared arm resources. This
   * factory must not start Pi; the coordinator invokes the Gate afterward.
   */
  readonly prepareCampaignWithoutStartingAgentOnce: (input: {
    readonly portfolioFreeze: M7R3TwoCasePortfolioFreezeV1;
    readonly constructionReceipt: M7R3CaseConstructionReceiptV1;
    readonly preflightReceipt: M7R3CasePreflightReceiptV1;
    readonly caseContract: M7R3PairedCaseContractV1;
    readonly signal?: AbortSignal | undefined;
  }) => Promise<M7R3PreparedLocalCaseCampaignV1>;
  /**
   * Cleanup owned resources if the preparation promise rejects before it can
   * return the prepared campaign cleanup hook.
   */
  readonly abortPreparation: () => Promise<unknown>;
  readonly persistInfrastructureFailureOnce: (
    input: M7R3CampaignInfrastructureFailureInputV1,
  ) => Promise<Sha256DigestV1>;
}

export type M7R3LocalCampaignGateRunnerV1 =
  typeof runM7R3RuntimeUseLocalCampaignGateV1;

export interface RunM7R3TwoCaseLocalPortfolioV1Input {
  /** Read from the authoritative create-once construction store. */
  readonly trajectoryClassifierFreeze: unknown;
  /** Read in fixed ordinal order from that store; never regenerated here. */
  readonly constructionReceipts: readonly [unknown, unknown];
  readonly portfolioFreezeInput: CreateM7R3TwoCasePortfolioFreezeV1Input;
  readonly portfolioStore: M7R3TwoCaseLocalPortfolioStorePortV1;
  readonly cases: readonly [
    M7R3TwoCaseLocalCasePlanV1<1>,
    M7R3TwoCaseLocalCasePlanV1<2>,
  ];
  readonly runCampaignGateOnce?: M7R3LocalCampaignGateRunnerV1 | undefined;
  readonly now?: (() => string) | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface M7R3PortfolioSafetyStopV1 {
  readonly triggerCaseOrdinal: 1;
  readonly reason: "cleanup_not_proven" | "sandbox_safety_failure";
  readonly receiptSha256: Sha256DigestV1;
}

export interface M7R3TwoCaseLocalPortfolioRunV1 {
  readonly portfolioFreeze: M7R3TwoCasePortfolioFreezeV1;
  readonly caseReferences: readonly [
    M7R3PortfolioCaseReferenceV1,
    M7R3PortfolioCaseReferenceV1,
  ];
  /** Null unless case 1 made starting case 2 unsafe. */
  readonly safetyStop: M7R3PortfolioSafetyStopV1 | null;
  /** Reference-only denominator index; it contains no causal prose/verdict. */
  readonly summary: M7R3TwoCasePortfolioSummaryV1;
}

const constructionPortfolioProjection = (
  construction: M7R3CaseConstructionReceiptV1,
) =>
  M7R3PortfolioCaseConstructionProjectionV1Schema.parse({
    subject: {
      subjectProjectSha256: construction.pristineSubject.subjectProjectSha256,
      pristineProjectRevision: construction.pristineSubject.revision,
      pristineSelectedTreeSha256:
        construction.pristineSubject.selectedTreeSha256,
    },
    mutant: {
      mutationSha256: construction.mutation.mutationSha256,
      mutatedBuildSourceId: construction.mutatedBuild.sourceId,
      mutatedBuildSourceSha256: construction.mutatedBuild.sourceSha256,
      mutatedBaselineSelectedTreeSha256:
        construction.mutatedBuild.selectedTreeSha256,
      mutatedBuildSourceIdentitySha256:
        construction.mutatedBuild.sourceIdentitySha256,
    },
    naturalPromptUtf8Sha256: construction.naturalPrompt.utf8Sha256,
    trajectoryCaseSpecId: construction.trajectoryCaseSpec.caseId,
    trajectoryCaseSpecSha256: construction.trajectoryCaseSpec.caseSpecSha256,
    adapterMutantCompatibilityReceiptSha256:
      construction.adapterMutantCompatibility.receiptRecordSha256,
    pairedPublicTaskContractSha256:
      construction.pairedPublicTaskContract.sha256,
    preflightImplementationSha256: construction.preflightImplementation.sha256,
    evaluatorImplementationSha256: construction.evaluatorImplementation.sha256,
    evaluatorBundleSha256: construction.evaluatorBundle.sha256,
  });

const frozenCaseProjection = (
  value: M7R3TwoCasePortfolioFreezeV1["cases"][number],
) =>
  M7R3PortfolioCaseConstructionProjectionV1Schema.parse({
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

const validateFrozenDesign = (input: {
  readonly freeze: M7R3TrajectoryClassifierFreezeV1;
  readonly constructions: readonly [
    M7R3CaseConstructionReceiptV1,
    M7R3CaseConstructionReceiptV1,
  ];
  readonly portfolio: M7R3TwoCasePortfolioFreezeV1;
}): void => {
  const expectedCommon = projectM7R3ClassifierFreezeToPortfolioV1(input.freeze);
  for (const [key, value] of Object.entries(expectedCommon)) {
    if (
      input.portfolio.commonRuntimeMaterials[
        key as keyof typeof expectedCommon
      ] !== value
    ) {
      throw new TypeError(
        "M7 R3 portfolio crossed its authoritative classifier freeze",
      );
    }
  }
  input.constructions.forEach((construction, index) => {
    const ordinal = (index + 1) as 1 | 2;
    if (
      construction.ordinal !== ordinal ||
      construction.trajectoryClassifierFreezeId !==
        input.freeze.classifierFreezeId ||
      construction.trajectoryClassifierFreezeRecordSha256 !==
        input.freeze.recordContentSha256 ||
      construction.authoritativeSensorFreezeRecordSha256 !==
        input.freeze.authoritativeSensorFreezeRecordSha256 ||
      construction.classifierImplementationSha256 !==
        input.freeze.classifierImplementationSha256 ||
      construction.classifierConfigSha256 !==
        input.freeze.classifierConfig.configSha256 ||
      Date.parse(construction.constructedAt) < Date.parse(input.freeze.frozenAt)
    ) {
      throw new TypeError(
        `M7 R3 case ${ordinal} construction crossed its pre-mutation classifier freeze`,
      );
    }
    if (
      !sameJson(
        constructionPortfolioProjection(construction),
        frozenCaseProjection(input.portfolio.cases[index]!),
      )
    ) {
      throw new TypeError(
        `M7 R3 case ${ordinal} portfolio identity crossed its construction receipt`,
      );
    }
  });
  const latestConstruction = Math.max(
    ...input.constructions.map((value) => Date.parse(value.constructedAt)),
  );
  if (Date.parse(input.portfolio.frozenAt) < latestConstruction) {
    throw new TypeError(
      "M7 R3 portfolio must be frozen after both construction receipts",
    );
  }
};

type PreAgentStage =
  | Readonly<{
      disposition: "construction_failed";
      construction: M7R3CaseConstructionReceiptV1;
    }>
  | Readonly<{
      disposition: "preflight_failed";
      construction: M7R3CaseConstructionReceiptV1;
      preflight: M7R3CasePreflightReceiptV1;
    }>
  | Readonly<{
      disposition: "ready";
      construction: M7R3CaseConstructionReceiptV1;
      preflight: M7R3CasePreflightReceiptV1;
    }>;

const runPreAgentStage = async (input: {
  readonly ordinal: 1 | 2;
  readonly construction: M7R3CaseConstructionReceiptV1;
  readonly freeze: M7R3TrajectoryClassifierFreezeV1;
  readonly portfolio: M7R3TwoCasePortfolioFreezeV1;
  readonly plan: M7R3TwoCaseLocalCasePlanV1<1> | M7R3TwoCaseLocalCasePlanV1<2>;
  readonly signal?: AbortSignal | undefined;
}): Promise<PreAgentStage> => {
  if (input.construction.outcome === "construction_failed") {
    return {
      disposition: "construction_failed",
      construction: input.construction,
    };
  }
  const preflight = M7R3CasePreflightReceiptV1Schema.parse(
    await input.plan.runAndPersistPreflightOnce({
      portfolioFreeze: input.portfolio,
      constructionReceipt: input.construction,
      trajectoryClassifierFreeze: input.freeze,
      signal: input.signal,
    }),
  );
  if (
    preflight.ordinal !== input.ordinal ||
    preflight.portfolio.portfolioId !== input.portfolio.portfolioId ||
    preflight.portfolio.portfolioFreezeRecordSha256 !==
      input.portfolio.recordContentSha256 ||
    preflight.constructionReceiptSha256 !==
      input.construction.recordContentSha256 ||
    preflight.trajectoryClassifierFreezeRecordSha256 !==
      input.freeze.recordContentSha256 ||
    !sameJson(preflight.portfolioFreeze, input.portfolio) ||
    !sameJson(preflight.constructionReceipt, input.construction) ||
    !sameJson(preflight.trajectoryClassifierFreeze, input.freeze)
  ) {
    throw new TypeError(
      `M7 R3 case ${input.ordinal} preflight crossed its frozen Host inputs`,
    );
  }
  return preflight.outcome === "passed"
    ? { disposition: "ready", construction: input.construction, preflight }
    : {
        disposition: "preflight_failed",
        construction: input.construction,
        preflight,
      };
};

const validateCaseContract = (input: {
  readonly ordinal: 1 | 2;
  readonly portfolio: M7R3TwoCasePortfolioFreezeV1;
  readonly construction: M7R3CaseConstructionReceiptV1;
  readonly freeze: M7R3TrajectoryClassifierFreezeV1;
  readonly contract: unknown;
}): M7R3PairedCaseContractV1 => {
  const contract = M7R3PairedCaseContractV1Schema.parse(input.contract);
  const frozenCase = input.portfolio.cases[input.ordinal - 1]!;
  if (
    contract.portfolioId !== input.portfolio.portfolioId ||
    contract.caseOrdinal !== input.ordinal ||
    contract.caseId !== frozenCase.caseId ||
    contract.mutatedBaselineSelectedTreeSha256 !==
      input.construction.mutatedBuild.selectedTreeSha256 ||
    contract.naturalPrompt.utf8Sha256 !==
      input.construction.naturalPrompt.utf8Sha256 ||
    contract.naturalPrompt.canonicalJsonSha256 !==
      input.construction.naturalPrompt.canonicalJsonSha256 ||
    contract.pairedPublicTaskContractSha256 !==
      input.construction.pairedPublicTaskContract.sha256 ||
    contract.adapterMutantCompatibilityReceiptSha256 !==
      input.construction.adapterMutantCompatibility.receiptRecordSha256 ||
    !sameJson(
      contract.commonRuntimeMaterials,
      input.portfolio.commonRuntimeMaterials,
    ) ||
    !sameJson(
      contract.agentConfiguration,
      input.portfolio.agentConfiguration,
    ) ||
    !sameJson(
      contract.trajectoryClassifierConfig,
      input.freeze.classifierConfig,
    ) ||
    !sameJson(
      contract.trajectoryCaseSpec,
      input.construction.trajectoryCaseSpec,
    )
  ) {
    throw new TypeError(
      `M7 R3 case ${input.ordinal} paired contract crossed its frozen construction or portfolio`,
    );
  }
  return contract;
};

const validatePreparedCampaign = async (input: {
  readonly ordinal: 1 | 2;
  readonly portfolio: M7R3TwoCasePortfolioFreezeV1;
  readonly construction: M7R3CaseConstructionReceiptV1;
  readonly contract: M7R3PairedCaseContractV1;
  readonly prepared: M7R3PreparedLocalCaseCampaignV1;
}) => {
  const admission = M7R3CaseCampaignAdmissionV1Schema.parse(
    input.prepared.caseAdmission,
  );
  const [registration, campaignPreflight] = await Promise.all([
    input.prepared.campaignStore
      .readMutationRegistration()
      .then((value) => M7MutationRegistrationV1Schema.parse(value)),
    input.prepared.campaignStore
      .readPreflight()
      .then((value) => M7MutationPreflightReceiptV1Schema.parse(value)),
  ]);
  const frozenCase = input.portfolio.cases[input.ordinal - 1]!;
  if (
    admission.portfolioId !== input.portfolio.portfolioId ||
    admission.portfolioFreezeRecordSha256 !==
      input.portfolio.recordContentSha256 ||
    admission.caseOrdinal !== input.ordinal ||
    admission.caseId !== frozenCase.caseId ||
    admission.portfolioCaseIdentitySha256 !== digestJson(frozenCase) ||
    admission.campaignId !== registration.campaignId ||
    admission.mutationRegistrationRecordSha256 !==
      registration.recordContentSha256 ||
    admission.mutant.mutationSha256 !==
      input.construction.mutation.mutationSha256 ||
    admission.mutant.mutatedBuildSourceId !==
      input.construction.mutatedBuild.sourceId ||
    admission.mutant.mutatedBuildSourceSha256 !==
      input.construction.mutatedBuild.sourceSha256 ||
    admission.mutant.mutatedBaselineSelectedTreeSha256 !==
      input.construction.mutatedBuild.selectedTreeSha256 ||
    admission.mutant.mutatedBuildSourceIdentitySha256 !==
      input.construction.mutatedBuild.sourceIdentitySha256 ||
    admission.prompt.utf8Sha256 !==
      input.construction.naturalPrompt.utf8Sha256 ||
    admission.prompt.canonicalJsonSha256 !==
      input.construction.naturalPrompt.canonicalJsonSha256 ||
    admission.trajectory.classifierFreezeRecordSha256 !==
      input.portfolio.commonRuntimeMaterials
        .trajectoryClassifierFreezeRecordSha256 ||
    admission.trajectory.classifierImplementationSha256 !==
      input.construction.classifierImplementationSha256 ||
    admission.trajectory.classifierConfigSha256 !==
      input.construction.classifierConfigSha256 ||
    admission.trajectory.caseSpecId !==
      input.construction.trajectoryCaseSpec.caseId ||
    admission.trajectory.caseSpecSha256 !==
      input.construction.trajectoryCaseSpec.caseSpecSha256 ||
    admission.authoritativeSensorFreezeRecordSha256 !==
      input.portfolio.commonRuntimeMaterials
        .authoritativeSensorFreezeRecordSha256 ||
    admission.pairedProtocol.pairedAgentProtocolImplementationSha256 !==
      input.contract.pairedAgentProtocolImplementationSha256 ||
    admission.pairedProtocol.pairedCaseContractContentSha256 !==
      input.contract.pairedCaseContractContentSha256 ||
    admission.pairedProtocol.pairedPublicTaskContractSha256 !==
      input.construction.pairedPublicTaskContract.sha256 ||
    admission.pairedProtocol.runtimeArmPublicTaskSpecSha256 !==
      input.contract.runtimeArmPublicTaskSpecSha256 ||
    admission.pairedProtocol.codeOnlyArmPublicTaskSpecSha256 !==
      input.contract.codeOnlyArmPublicTaskSpecSha256 ||
    admission.adapterMutantCompatibilityReceiptSha256 !==
      input.construction.adapterMutantCompatibility.receiptRecordSha256 ||
    admission.preflightImplementationSha256 !==
      input.construction.preflightImplementation.sha256 ||
    registration.mutationSha256 !==
      input.construction.mutation.mutationSha256 ||
    registration.mutatedBaselineSelectedTreeSha256 !==
      input.construction.mutatedBuild.selectedTreeSha256 ||
    registration.mutatedBuildSourceIdentitySha256 !==
      input.construction.mutatedBuild.sourceIdentitySha256 ||
    registration.adapterMutantCompatibilityReceiptSha256 !==
      input.construction.adapterMutantCompatibility.receiptRecordSha256 ||
    registration.publicTaskSpecSha256 !==
      input.contract.pairedPublicTaskContractSha256 ||
    registration.evaluatorImplementationSha256 !==
      input.construction.evaluatorImplementation.sha256 ||
    registration.evaluatorBundleSha256 !==
      input.construction.evaluatorBundle.sha256 ||
    registration.provider !== input.contract.agentConfiguration.provider ||
    registration.model !== input.contract.agentConfiguration.model ||
    registration.thinkingLevel !==
      input.contract.agentConfiguration.thinkingLevel ||
    registration.agentBudgetSha256 !==
      input.contract.agentConfiguration.agentBudgetSha256 ||
    registration.codingToolSetSha256 !==
      input.contract.agentConfiguration.codingToolSetSha256 ||
    registration.sandboxPolicySha256 !==
      input.contract.agentConfiguration.sandboxPolicySha256 ||
    registration.runtimeGameToolSetSha256 !==
      input.contract.commonRuntimeMaterials.validatedGameToolSetSha256 ||
    campaignPreflight.campaignId !== registration.campaignId ||
    campaignPreflight.mutationRegistrationSha256 !==
      registration.recordContentSha256 ||
    campaignPreflight.outcome !== "passed"
  ) {
    throw new TypeError(
      `M7 R3 case ${input.ordinal} prepared campaign crossed its mutation, prompt, Build, evaluator, or protocol binding`,
    );
  }
  return { admission, registration };
};

const readTerminalEvidence = async (input: {
  readonly terminal: M7CampaignTerminalRecordV1;
  readonly admission: M7R3CaseCampaignAdmissionV1;
  readonly contract: M7R3PairedCaseContractV1;
  readonly prepared: M7R3PreparedLocalCaseCampaignV1;
}) => {
  const [delivery, trajectoryUse] = await Promise.all([
    input.prepared.evidenceStore
      .readDeliveryTrace(input.terminal.campaignId, "runtime_enabled")
      .then((value) => M7R3StoredDeliveryTraceV1Schema.parse(value)),
    input.prepared.evidenceStore
      .readTrajectoryUse(input.terminal.campaignId)
      .then((value) => M7R3PatrolTrajectoryUseEvidenceV1Schema.parse(value)),
  ]);
  if (
    delivery.campaignId !== input.terminal.campaignId ||
    delivery.arm !== "runtime_enabled" ||
    delivery.caseCampaignAdmissionRecordSha256 !==
      input.admission.recordContentSha256 ||
    trajectoryUse.campaignId !== input.terminal.campaignId ||
    trajectoryUse.attemptBindingContentSha256 !==
      delivery.attemptBindingContentSha256 ||
    !sameJson(trajectoryUse.caseSpec, input.contract.trajectoryCaseSpec)
  ) {
    throw new TypeError(
      "M7 R3 campaign terminal crossed its retained delivery/use evidence",
    );
  }
  return { delivery, trajectoryUse };
};

const recordSafetyStop = (input: {
  readonly portfolio: M7R3TwoCasePortfolioFreezeV1;
  readonly recordedAt: string;
}): RecordM7R3PortfolioCaseOnceV1Input => ({
  portfolioId: input.portfolio.portfolioId,
  portfolioFreezeRecordSha256: input.portfolio.recordContentSha256,
  caseOrdinal: 2,
  caseId: input.portfolio.cases[1].caseId,
  disposition: "not_started_safety_stop",
  constructionReceiptSha256: null,
  preflightReceiptSha256: null,
  ...nullCampaignReferences,
  recordedAt: input.recordedAt,
});

export type M7R3LocalPortfolioPreAgentTerminalV1 =
  | Readonly<{
      disposition: "construction_failed";
      constructionReceiptSha256: Sha256DigestV1;
    }>
  | Readonly<{
      disposition: "preflight_failed";
      preflightReceiptSha256: Sha256DigestV1;
    }>
  | Readonly<{ disposition: "ready" }>;

export type M7R3LocalPortfolioCampaignReferenceV1 =
  | Readonly<{
      disposition: "campaign_terminal";
      campaignInfrastructureReceiptSha256: null;
      campaignId: string;
      caseCampaignAdmissionRecordSha256: Sha256DigestV1;
      mutationRegistrationRecordSha256: Sha256DigestV1;
      campaignTerminalRecordSha256: Sha256DigestV1;
      runtimeEnabledResultRecordSha256: Sha256DigestV1 | null;
      codeOnlyResultRecordSha256: Sha256DigestV1 | null;
      agentDeliveryTraceRecordSha256: Sha256DigestV1;
      trajectoryUseEvidenceRecordSha256: Sha256DigestV1;
      safetyStop: M7R3PortfolioSafetyStopV1 | null;
    }>
  | Readonly<{
      disposition: "campaign_infrastructure_failure";
      campaignInfrastructureReceiptSha256: Sha256DigestV1;
      campaignId: string | null;
      caseCampaignAdmissionRecordSha256: Sha256DigestV1 | null;
      mutationRegistrationRecordSha256: Sha256DigestV1 | null;
      campaignTerminalRecordSha256: null;
      runtimeEnabledResultRecordSha256: null;
      codeOnlyResultRecordSha256: null;
      agentDeliveryTraceRecordSha256: null;
      trajectoryUseEvidenceRecordSha256: null;
      safetyStop: M7R3PortfolioSafetyStopV1 | null;
    }>;

export interface RunM7R3TwoCaseLocalPortfolioCoreV1Input {
  readonly portfolioFreeze: M7R3TwoCasePortfolioFreezeV1;
  readonly portfolioStore: M7R3TwoCaseLocalPortfolioStorePortV1;
  /** Each function is a no-Agent, create-once preflight terminal. */
  readonly resolvePreAgentStageOnce: readonly [
    () => Promise<M7R3LocalPortfolioPreAgentTerminalV1>,
    () => Promise<M7R3LocalPortfolioPreAgentTerminalV1>,
  ];
  /** Each function owns one complete runtime -> cleanup -> code-only Gate. */
  readonly runCampaignGateOnce: readonly [
    () => Promise<M7R3LocalPortfolioCampaignReferenceV1>,
    () => Promise<M7R3LocalPortfolioCampaignReferenceV1>,
  ];
  readonly now: () => string;
}

const coreStageSchema = z.discriminatedUnion("disposition", [
  z
    .object({
      disposition: z.literal("construction_failed"),
      constructionReceiptSha256: Sha256DigestV1Schema,
    })
    .strict(),
  z
    .object({
      disposition: z.literal("preflight_failed"),
      preflightReceiptSha256: Sha256DigestV1Schema,
    })
    .strict(),
  z.object({ disposition: z.literal("ready") }).strict(),
]);

const safetyStopSchema = z
  .object({
    triggerCaseOrdinal: z.literal(1),
    reason: z.enum(["cleanup_not_proven", "sandbox_safety_failure"]),
    receiptSha256: Sha256DigestV1Schema,
  })
  .strict()
  .nullable();

const coreCampaignReferenceSchema = z.discriminatedUnion("disposition", [
  z
    .object({
      disposition: z.literal("campaign_terminal"),
      campaignInfrastructureReceiptSha256: z.null(),
      campaignId: M7CampaignTerminalRecordV1Schema.shape.campaignId,
      caseCampaignAdmissionRecordSha256: Sha256DigestV1Schema,
      mutationRegistrationRecordSha256: Sha256DigestV1Schema,
      campaignTerminalRecordSha256: Sha256DigestV1Schema,
      runtimeEnabledResultRecordSha256: Sha256DigestV1Schema.nullable(),
      codeOnlyResultRecordSha256: Sha256DigestV1Schema.nullable(),
      agentDeliveryTraceRecordSha256: Sha256DigestV1Schema,
      trajectoryUseEvidenceRecordSha256: Sha256DigestV1Schema,
      safetyStop: safetyStopSchema,
    })
    .strict(),
  z
    .object({
      disposition: z.literal("campaign_infrastructure_failure"),
      campaignInfrastructureReceiptSha256: Sha256DigestV1Schema,
      campaignId: M7CampaignTerminalRecordV1Schema.shape.campaignId.nullable(),
      caseCampaignAdmissionRecordSha256: Sha256DigestV1Schema.nullable(),
      mutationRegistrationRecordSha256: Sha256DigestV1Schema.nullable(),
      campaignTerminalRecordSha256: z.null(),
      runtimeEnabledResultRecordSha256: z.null(),
      codeOnlyResultRecordSha256: z.null(),
      agentDeliveryTraceRecordSha256: z.null(),
      trajectoryUseEvidenceRecordSha256: z.null(),
      safetyStop: safetyStopSchema,
    })
    .strict(),
]);

/**
 * Offline orchestration seam. Production passes only outputs that have
 * already survived the exact R3 DTO/lineage checks above.
 */
export async function runM7R3TwoCaseLocalPortfolioCoreV1(
  input: RunM7R3TwoCaseLocalPortfolioCoreV1Input,
): Promise<
  Omit<M7R3TwoCaseLocalPortfolioRunV1, "portfolioFreeze"> & {
    readonly portfolioFreeze: M7R3TwoCasePortfolioFreezeV1;
  }
> {
  const portfolio = M7R3TwoCasePortfolioFreezeV1Schema.parse(
    input.portfolioFreeze,
  );
  // The Host runtime/controller may be shared, so preflights are intentionally
  // sequential. Both still finish before the first campaign callback.
  const stages = [
    coreStageSchema.parse(await input.resolvePreAgentStageOnce[0]()),
    coreStageSchema.parse(await input.resolvePreAgentStageOnce[1]()),
  ] as const satisfies readonly [
    z.infer<typeof coreStageSchema>,
    z.infer<typeof coreStageSchema>,
  ];
  const references: M7R3PortfolioCaseReferenceV1[] = [];
  let safetyStop: M7R3PortfolioSafetyStopV1 | null = null;
  for (const index of [0, 1] as const) {
    const ordinal = (index + 1) as 1 | 2;
    const frozenCase = portfolio.cases[index];
    const stage = stages[index];
    let recordInput: RecordM7R3PortfolioCaseOnceV1Input;
    if (stage.disposition === "construction_failed") {
      recordInput = {
        portfolioId: portfolio.portfolioId,
        portfolioFreezeRecordSha256: portfolio.recordContentSha256,
        caseOrdinal: ordinal,
        caseId: frozenCase.caseId,
        disposition: "construction_failed",
        constructionReceiptSha256: stage.constructionReceiptSha256,
        preflightReceiptSha256: null,
        ...nullCampaignReferences,
        recordedAt: input.now(),
      };
    } else if (stage.disposition === "preflight_failed") {
      recordInput = {
        portfolioId: portfolio.portfolioId,
        portfolioFreezeRecordSha256: portfolio.recordContentSha256,
        caseOrdinal: ordinal,
        caseId: frozenCase.caseId,
        disposition: "preflight_failed",
        constructionReceiptSha256: null,
        preflightReceiptSha256: stage.preflightReceiptSha256,
        ...nullCampaignReferences,
        recordedAt: input.now(),
      };
    } else if (ordinal === 2 && safetyStop !== null) {
      recordInput = recordSafetyStop({ portfolio, recordedAt: input.now() });
    } else {
      const campaign = coreCampaignReferenceSchema.parse(
        await input.runCampaignGateOnce[index](),
      );
      if (ordinal === 2 && campaign.safetyStop !== null) {
        throw new TypeError(
          "M7 R3 case 2 cannot stop a nonexistent later portfolio case",
        );
      }
      const campaignCommon = {
        portfolioId: portfolio.portfolioId,
        portfolioFreezeRecordSha256: portfolio.recordContentSha256,
        caseOrdinal: ordinal,
        caseId: frozenCase.caseId,
        constructionReceiptSha256: null,
        preflightReceiptSha256: null,
        recordedAt: input.now(),
      } as const;
      recordInput =
        campaign.disposition === "campaign_terminal"
          ? {
              ...campaignCommon,
              disposition: "campaign_terminal",
              campaignInfrastructureReceiptSha256: null,
              campaignId: campaign.campaignId,
              caseCampaignAdmissionRecordSha256:
                campaign.caseCampaignAdmissionRecordSha256,
              mutationRegistrationRecordSha256:
                campaign.mutationRegistrationRecordSha256,
              campaignTerminalRecordSha256:
                campaign.campaignTerminalRecordSha256,
              runtimeEnabledResultRecordSha256:
                campaign.runtimeEnabledResultRecordSha256,
              codeOnlyResultRecordSha256: campaign.codeOnlyResultRecordSha256,
              agentDeliveryTraceRecordSha256:
                campaign.agentDeliveryTraceRecordSha256,
              trajectoryUseEvidenceRecordSha256:
                campaign.trajectoryUseEvidenceRecordSha256,
            }
          : {
              ...campaignCommon,
              disposition: "campaign_infrastructure_failure",
              campaignInfrastructureReceiptSha256:
                campaign.campaignInfrastructureReceiptSha256,
              campaignId: campaign.campaignId,
              caseCampaignAdmissionRecordSha256:
                campaign.caseCampaignAdmissionRecordSha256,
              mutationRegistrationRecordSha256:
                campaign.mutationRegistrationRecordSha256,
              campaignTerminalRecordSha256: null,
              runtimeEnabledResultRecordSha256: null,
              codeOnlyResultRecordSha256: null,
              agentDeliveryTraceRecordSha256: null,
              trajectoryUseEvidenceRecordSha256: null,
            };
      if (ordinal === 1) safetyStop = campaign.safetyStop;
    }
    const reference = M7R3PortfolioCaseReferenceV1Schema.parse(
      await input.portfolioStore.recordCaseOnce(recordInput),
    );
    if (
      reference.caseOrdinal !== ordinal ||
      reference.portfolioId !== portfolio.portfolioId ||
      reference.portfolioFreezeRecordSha256 !== portfolio.recordContentSha256 ||
      reference.caseId !== frozenCase.caseId
    ) {
      throw new TypeError(
        `M7 R3 portfolio store changed case ${ordinal} reference identity`,
      );
    }
    references.push(reference);
  }
  const summary = M7R3TwoCasePortfolioSummaryV1Schema.parse(
    await input.portfolioStore.finalizeSummaryOnce(input.now()),
  );
  if (
    summary.portfolioId !== portfolio.portfolioId ||
    summary.portfolioFreezeRecordSha256 !== portfolio.recordContentSha256 ||
    !sameJson(
      summary.cases.map((value) => value.caseReferenceRecordSha256),
      references.map((value) => value.recordContentSha256),
    )
  ) {
    throw new TypeError(
      "M7 R3 portfolio summary crossed its two retained case references",
    );
  }
  const caseReferences: readonly [
    M7R3PortfolioCaseReferenceV1,
    M7R3PortfolioCaseReferenceV1,
  ] = [references[0]!, references[1]!];
  return Object.freeze({
    portfolioFreeze: portfolio,
    caseReferences: Object.freeze(caseReferences),
    safetyStop,
    summary,
  });
}

export async function retainM7R3CampaignInfrastructureFailureV1(input: {
  readonly portfolioFreeze: M7R3TwoCasePortfolioFreezeV1;
  readonly caseOrdinal: 1 | 2;
  readonly stage: M7R3CampaignInfrastructureFailureStageV1;
  readonly error: unknown;
  readonly agentStarted: boolean;
  readonly campaignId: string | null;
  readonly caseCampaignAdmissionRecordSha256: Sha256DigestV1 | null;
  readonly mutationRegistrationRecordSha256: Sha256DigestV1 | null;
  readonly observedTerminalRecordSha256: Sha256DigestV1 | null;
  readonly cleanupRemainingAfterFailure: () => Promise<unknown>;
  /** A cleanup attempt already made by the normal post-Gate close path. */
  readonly completedResidualCleanup?: M7R3ResidualCleanupResultV1 | undefined;
  readonly persistInfrastructureFailureOnce: (
    receipt: M7R3CampaignInfrastructureFailureInputV1,
  ) => Promise<Sha256DigestV1>;
  readonly now: () => string;
}): Promise<M7R3LocalPortfolioCampaignReferenceV1> {
  const portfolio = M7R3TwoCasePortfolioFreezeV1Schema.parse(
    input.portfolioFreeze,
  );
  const frozenCase = portfolio.cases[input.caseOrdinal - 1]!;
  let cleanup: M7R3ResidualCleanupResultV1 = unprovenResidualCleanup();
  // Cleanup is deliberately in finally so every caught preparation/Gate/
  // evidence failure attempts residual Host cleanup before publication.
  if (input.completedResidualCleanup === undefined) {
    try {
      // The failure itself is already captured; raw Error content never enters
      // the persisted input below.
    } finally {
      cleanup = (
        await attemptM7R3ResidualCampaignCleanupV1(
          input.cleanupRemainingAfterFailure,
        )
      ).cleanup;
    }
  } else {
    cleanup = M7R3ResidualCleanupResultV1Schema.parse(
      input.completedResidualCleanup,
    );
  }
  const failureInput = M7R3CampaignInfrastructureFailureInputV1Schema.parse({
    schemaVersion: 1,
    portfolioId: portfolio.portfolioId,
    caseOrdinal: input.caseOrdinal,
    caseId: frozenCase.caseId,
    stage: input.stage,
    errorClassSha256: errorClassSha256(input.error),
    agentStarted: input.agentStarted,
    cleanupProven: cleanup.cleanupProven,
    cleanupReceiptSha256: cleanup.cleanupReceiptSha256,
    sandboxSafetyFailure: cleanup.sandboxSafetyFailure,
    sandboxSafetyReceiptSha256: cleanup.sandboxSafetyReceiptSha256,
    campaignId: input.campaignId,
    caseCampaignAdmissionRecordSha256: input.caseCampaignAdmissionRecordSha256,
    mutationRegistrationRecordSha256: input.mutationRegistrationRecordSha256,
    observedTerminalRecordSha256: input.observedTerminalRecordSha256,
    observedAt: input.now(),
  });
  const failureReceiptSha256 = Sha256DigestV1Schema.parse(
    await input.persistInfrastructureFailureOnce(failureInput),
  );
  const safetyStop: M7R3PortfolioSafetyStopV1 | null =
    input.caseOrdinal !== 1
      ? null
      : !cleanup.cleanupProven
        ? {
            triggerCaseOrdinal: 1,
            reason: "cleanup_not_proven",
            receiptSha256: failureReceiptSha256,
          }
        : cleanup.sandboxSafetyFailure
          ? {
              triggerCaseOrdinal: 1,
              reason: "sandbox_safety_failure",
              receiptSha256: Sha256DigestV1Schema.parse(
                cleanup.sandboxSafetyReceiptSha256,
              ),
            }
          : null;
  return coreCampaignReferenceSchema.parse({
    disposition: "campaign_infrastructure_failure",
    campaignInfrastructureReceiptSha256: failureReceiptSha256,
    campaignId: input.campaignId,
    caseCampaignAdmissionRecordSha256: input.caseCampaignAdmissionRecordSha256,
    mutationRegistrationRecordSha256: input.mutationRegistrationRecordSha256,
    campaignTerminalRecordSha256: null,
    runtimeEnabledResultRecordSha256: null,
    codeOnlyResultRecordSha256: null,
    agentDeliveryTraceRecordSha256: null,
    trajectoryUseEvidenceRecordSha256: null,
    safetyStop,
  });
}

/**
 * Runs one immutable two-case local portfolio. The Gate owns the exact
 * runtime-enabled -> cleanup -> code-only sequence for each admitted case;
 * this coordinator calls that Gate once per runnable case and never retries.
 */
export async function runM7R3TwoCaseLocalPortfolioV1(
  input: RunM7R3TwoCaseLocalPortfolioV1Input,
): Promise<M7R3TwoCaseLocalPortfolioRunV1> {
  const now = input.now ?? (() => new Date().toISOString());
  const gate =
    input.runCampaignGateOnce ?? runM7R3RuntimeUseLocalCampaignGateV1;
  if (input.cases[0].ordinal !== 1 || input.cases[1].ordinal !== 2) {
    throw new TypeError("M7 R3 coordinator requires fixed case order 1 then 2");
  }
  const freeze = M7R3TrajectoryClassifierFreezeV1Schema.parse(
    input.trajectoryClassifierFreeze,
  );
  const constructions = input.constructionReceipts.map((value) =>
    M7R3CaseConstructionReceiptV1Schema.parse(value),
  ) as unknown as readonly [
    M7R3CaseConstructionReceiptV1,
    M7R3CaseConstructionReceiptV1,
  ];
  if (constructions[0].ordinal !== 1 || constructions[1].ordinal !== 2) {
    throw new TypeError(
      "M7 R3 coordinator requires exactly two construction receipts in ordinal order",
    );
  }

  // This deterministic preview validates the complete design before the
  // create-once store call. The store remains the publication authority.
  const expectedPortfolio = createM7R3TwoCasePortfolioFreezeV1(
    input.portfolioFreezeInput,
  );
  validateFrozenDesign({ freeze, constructions, portfolio: expectedPortfolio });
  const portfolio = M7R3TwoCasePortfolioFreezeV1Schema.parse(
    await input.portfolioStore.createPortfolioOnce(input.portfolioFreezeInput),
  );
  if (!sameJson(portfolio, expectedPortfolio)) {
    throw new TypeError(
      "M7 R3 portfolio store changed the create-once frozen design",
    );
  }

  const resolvedStages: [PreAgentStage | null, PreAgentStage | null] = [
    null,
    null,
  ];
  const resolveStage = (index: 0 | 1) => async () => {
    const stage = await runPreAgentStage({
      ordinal: (index + 1) as 1 | 2,
      construction: constructions[index],
      freeze,
      portfolio,
      plan: input.cases[index],
      signal: input.signal,
    });
    resolvedStages[index] = stage;
    switch (stage.disposition) {
      case "construction_failed":
        return {
          disposition: "construction_failed" as const,
          constructionReceiptSha256: stage.construction.recordContentSha256,
        };
      case "preflight_failed":
        return {
          disposition: "preflight_failed" as const,
          preflightReceiptSha256: stage.preflight.recordContentSha256,
        };
      case "ready":
        return { disposition: "ready" as const };
    }
  };
  const runCampaign = (index: 0 | 1) => async () => {
    const ordinal = (index + 1) as 1 | 2;
    const stage = resolvedStages[index];
    const plan = input.cases[index];
    if (stage === null || stage.disposition !== "ready") {
      throw new TypeError(
        `M7 R3 case ${ordinal} campaign cannot start before its passed preflight`,
      );
    }
    const retainFailure = async (failure: {
      readonly stage: M7R3CampaignInfrastructureFailureStageV1;
      readonly error: unknown;
      readonly prepared?: M7R3PreparedLocalCaseCampaignV1 | undefined;
      readonly admission?: M7R3CaseCampaignAdmissionV1 | undefined;
      readonly registration?:
        | Awaited<
            ReturnType<M7RuntimeUseCampaignStoreV1["readMutationRegistration"]>
          >
        | undefined;
      readonly terminal?: M7CampaignTerminalRecordV1 | undefined;
      readonly completedResidualCleanup?:
        M7R3ResidualCleanupResultV1 | undefined;
    }): Promise<M7R3LocalPortfolioCampaignReferenceV1> => {
      let agentStarted = false;
      if (failure.prepared !== undefined) {
        try {
          agentStarted = failure.prepared.hasAgentStarted();
        } catch {
          // Conservatively retain that an Agent may have started.
          agentStarted = true;
        }
      }
      const campaignId =
        failure.registration?.campaignId ??
        failure.admission?.campaignId ??
        failure.terminal?.campaignId ??
        null;
      return retainM7R3CampaignInfrastructureFailureV1({
        portfolioFreeze: portfolio,
        caseOrdinal: ordinal,
        stage: failure.stage,
        error: failure.error,
        agentStarted,
        campaignId,
        caseCampaignAdmissionRecordSha256:
          failure.admission?.recordContentSha256 ?? null,
        mutationRegistrationRecordSha256:
          failure.registration?.recordContentSha256 ?? null,
        observedTerminalRecordSha256:
          failure.terminal?.recordContentSha256 ?? null,
        cleanupRemainingAfterFailure:
          failure.prepared?.cleanupRemainingAfterFailure ??
          plan.abortPreparation,
        completedResidualCleanup: failure.completedResidualCleanup,
        persistInfrastructureFailureOnce:
          failure.prepared?.persistInfrastructureFailureOnce ??
          plan.persistInfrastructureFailureOnce,
        now,
      });
    };

    let contract: M7R3PairedCaseContractV1;
    try {
      contract = validateCaseContract({
        ordinal,
        portfolio,
        construction: stage.construction,
        freeze,
        contract: plan.caseContract,
      });
    } catch (error) {
      return retainFailure({ stage: "case_contract_validation", error });
    }
    let prepared: M7R3PreparedLocalCaseCampaignV1;
    try {
      prepared = await plan.prepareCampaignWithoutStartingAgentOnce({
        portfolioFreeze: portfolio,
        constructionReceipt: stage.construction,
        preflightReceipt: stage.preflight,
        caseContract: contract,
        signal: input.signal,
      });
    } catch (error) {
      return retainFailure({ stage: "campaign_preparation", error });
    }
    let admission: M7R3CaseCampaignAdmissionV1;
    let registration: Awaited<
      ReturnType<M7RuntimeUseCampaignStoreV1["readMutationRegistration"]>
    >;
    try {
      ({ admission, registration } = await validatePreparedCampaign({
        ordinal,
        portfolio,
        construction: stage.construction,
        contract,
        prepared,
      }));
    } catch (error) {
      const parsedAdmission = M7R3CaseCampaignAdmissionV1Schema.safeParse(
        prepared.caseAdmission,
      );
      let parsedRegistration:
        | Awaited<
            ReturnType<M7RuntimeUseCampaignStoreV1["readMutationRegistration"]>
          >
        | undefined;
      try {
        parsedRegistration = M7MutationRegistrationV1Schema.parse(
          await prepared.campaignStore.readMutationRegistration(),
        );
      } catch {
        parsedRegistration = undefined;
      }
      return retainFailure({
        stage: "prepared_campaign_validation",
        error,
        prepared,
        admission: parsedAdmission.success ? parsedAdmission.data : undefined,
        registration: parsedRegistration,
      });
    }
    let terminal: M7CampaignTerminalRecordV1;
    try {
      terminal = M7CampaignTerminalRecordV1Schema.parse(
        await gate({
          campaignId: registration.campaignId,
          campaignStore: prepared.campaignStore,
          caseAdmission: admission,
          caseContract: contract,
          armPort: prepared.armPort,
          evaluatorPorts: prepared.evaluatorPorts,
          evidenceStore: prepared.evidenceStore,
          now,
          signal: input.signal,
        }),
      );
      if (terminal.campaignId !== registration.campaignId) {
        throw new TypeError(
          `M7 R3 case ${ordinal} Gate returned another campaign terminal`,
        );
      }
    } catch (error) {
      return retainFailure({
        stage: "campaign_gate",
        error,
        prepared,
        admission,
        registration,
      });
    }
    let evidence: Awaited<ReturnType<typeof readTerminalEvidence>>;
    try {
      evidence = await readTerminalEvidence({
        terminal,
        admission,
        contract,
        prepared,
      });
    } catch (error) {
      return retainFailure({
        stage: "terminal_evidence",
        error,
        prepared,
        admission,
        registration,
        terminal,
      });
    }
    let safetyStop: M7R3PortfolioSafetyStopV1 | null = null;
    if (ordinal === 1) {
      if (terminal.outcome === "cleanup_failed") {
        safetyStop = {
          triggerCaseOrdinal: 1,
          reason: "cleanup_not_proven",
          receiptSha256: terminal.recordContentSha256,
        };
      } else {
        let sandboxReceipt: Sha256DigestV1 | null;
        try {
          sandboxReceipt = await prepared
            .readSandboxSafetyFailureReceiptAfterGate(terminal)
            .then((value) =>
              value === null ? null : Sha256DigestV1Schema.parse(value),
            );
        } catch (error) {
          return retainFailure({
            stage: "sandbox_safety_inspection",
            error,
            prepared,
            admission,
            registration,
            terminal,
          });
        }
        if (sandboxReceipt !== null) {
          safetyStop = {
            triggerCaseOrdinal: 1,
            reason: "sandbox_safety_failure",
            receiptSha256: sandboxReceipt,
          };
        }
      }
    }
    const residualCleanup = await attemptM7R3ResidualCampaignCleanupV1(
      prepared.cleanupRemainingAfterFailure,
    );
    if (
      residualCleanup.outcome === "failed" ||
      !residualCleanup.cleanup.cleanupProven ||
      residualCleanup.cleanup.sandboxSafetyFailure
    ) {
      return retainFailure({
        stage: "residual_cleanup",
        error:
          residualCleanup.outcome === "failed"
            ? residualCleanup.error
            : new Error(
                residualCleanup.cleanup.sandboxSafetyFailure
                  ? "sandbox safety failure"
                  : "residual cleanup was not proven",
              ),
        prepared,
        admission,
        registration,
        terminal,
        completedResidualCleanup: residualCleanup.cleanup,
      });
    }
    return {
      disposition: "campaign_terminal" as const,
      campaignInfrastructureReceiptSha256: null,
      campaignId: terminal.campaignId,
      caseCampaignAdmissionRecordSha256: admission.recordContentSha256,
      mutationRegistrationRecordSha256: registration.recordContentSha256,
      campaignTerminalRecordSha256: terminal.recordContentSha256,
      runtimeEnabledResultRecordSha256: terminal.runtimeEnabledResultSha256,
      codeOnlyResultRecordSha256: terminal.codeOnlyResultSha256,
      agentDeliveryTraceRecordSha256: evidence.delivery.recordContentSha256,
      trajectoryUseEvidenceRecordSha256:
        evidence.trajectoryUse.recordContentSha256,
      safetyStop,
    };
  };

  return runM7R3TwoCaseLocalPortfolioCoreV1({
    portfolioFreeze: portfolio,
    portfolioStore: input.portfolioStore,
    resolvePreAgentStageOnce: [resolveStage(0), resolveStage(1)],
    runCampaignGateOnce: [runCampaign(0), runCampaign(1)],
    now,
  });
}

/** Concrete store type assertion kept close to the composition boundary. */
export const asM7R3TwoCaseLocalPortfolioStorePortV1 = (
  store: M7R3TwoCasePortfolioStoreV1,
): M7R3TwoCaseLocalPortfolioStorePortV1 => store;
