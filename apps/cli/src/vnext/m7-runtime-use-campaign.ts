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
  type SourceId,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { z } from "zod";

import { publishPrivateFileOnceV1 } from "./private-atomic-publication.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const RECORD_BYTE_LIMIT = 1024 * 1024;

const sensorFreezeIdSchema = z
  .string()
  .regex(/^m7-sensor-freeze:[a-f0-9]{24}$/u);
const campaignSensorBindingIdSchema = z
  .string()
  .regex(/^m7-campaign-sensor-binding:[a-f0-9]{24}$/u);
const campaignIdSchema = z.string().regex(/^m7-campaign:[a-f0-9]{24}$/u);
const gitRevisionSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const safeIdentitySchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u);

const digest = (bytes: string | Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

const digestJson = (value: unknown): Sha256DigestV1 =>
  digest(canonicalJson(JsonValueSchema.parse(value)));

declare const m7BuildSourceIdentityBrand: unique symbol;
export type M7BuildSourceIdentitySha256V1 = Sha256DigestV1 & {
  readonly [m7BuildSourceIdentityBrand]: "M7BuildSourceIdentitySha256V1";
};

const m7BuildSourceIdentityBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceId: SourceIdSchema,
    sourceHash: Sha256DigestV1Schema,
  })
  .strict();

/** Hashes the explicit mutant Build source identity, not just selected-tree bytes. */
export const deriveM7BuildSourceIdentitySha256V1 = (input: {
  readonly sourceId: SourceId;
  readonly sourceHash: Sha256DigestV1;
}): M7BuildSourceIdentitySha256V1 =>
  digestJson(
    m7BuildSourceIdentityBasisSchema.parse({
      schemaVersion: 1,
      sourceId: input.sourceId,
      sourceHash: input.sourceHash,
    }),
  ) as M7BuildSourceIdentitySha256V1;

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
  const { recordContentSha256, ...recordBasis } = value;
  if (recordContentSha256 !== digestJson(recordBasis)) {
    addIssue(
      context,
      ["recordContentSha256"],
      "record content hash does not match its canonical bytes",
    );
  }
};

const campaignSensorBindingIdentitySchema = z
  .object({
    schemaVersion: z.literal(1),
    authoritativeSensorFreezeId: sensorFreezeIdSchema,
    authoritativeSensorFreezeRecordSha256: Sha256DigestV1Schema,
    subjectProjectSha256: Sha256DigestV1Schema,
    pristineProjectRevision: gitRevisionSchema,
    pristineSelectedTreeSha256: Sha256DigestV1Schema,
    pristineAdapterRevisionSha256: Sha256DigestV1Schema,
    adapterPackageSha256: Sha256DigestV1Schema,
    adapterObservationSchemaSha256: Sha256DigestV1Schema,
    publicPatrolClassifierSha256: Sha256DigestV1Schema,
    pristineConformanceReceiptSha256: Sha256DigestV1Schema,
    validatedGameToolSetSha256: Sha256DigestV1Schema,
  })
  .strict();

const campaignSensorBindingBaseSchema =
  campaignSensorBindingIdentitySchema.extend({
    recordKind: z.literal("m7-campaign-sensor-binding"),
    campaignSensorBindingId: campaignSensorBindingIdSchema,
    boundAt: z.string().datetime(),
    recordContentSha256: Sha256DigestV1Schema,
  });

/**
 * Durable Host-only campaign binding to the authoritative sensor-material
 * freeze owned by m7-patrol-sensor. It deliberately does not recreate or
 * reinterpret that freeze; it retains only its opaque ID/hash plus campaign
 * comparison identities needed by this store.
 */
export const M7CampaignSensorBindingV1Schema = campaignSensorBindingBaseSchema
  .strict()
  .superRefine((value, context) => {
    const identity = campaignSensorBindingIdentitySchema.parse({
      schemaVersion: value.schemaVersion,
      authoritativeSensorFreezeId: value.authoritativeSensorFreezeId,
      authoritativeSensorFreezeRecordSha256:
        value.authoritativeSensorFreezeRecordSha256,
      subjectProjectSha256: value.subjectProjectSha256,
      pristineProjectRevision: value.pristineProjectRevision,
      pristineSelectedTreeSha256: value.pristineSelectedTreeSha256,
      pristineAdapterRevisionSha256: value.pristineAdapterRevisionSha256,
      adapterPackageSha256: value.adapterPackageSha256,
      adapterObservationSchemaSha256: value.adapterObservationSchemaSha256,
      publicPatrolClassifierSha256: value.publicPatrolClassifierSha256,
      pristineConformanceReceiptSha256: value.pristineConformanceReceiptSha256,
      validatedGameToolSetSha256: value.validatedGameToolSetSha256,
    });
    const expectedId = `m7-campaign-sensor-binding:${digestJson(identity).slice(0, 24)}`;
    if (value.campaignSensorBindingId !== expectedId) {
      addIssue(
        context,
        ["campaignSensorBindingId"],
        "campaign sensor binding ID must derive from the authoritative freeze and pre-mutation comparison identities",
      );
    }
    validateContentHash(value, context);
  });
export type M7CampaignSensorBindingV1 = z.infer<
  typeof M7CampaignSensorBindingV1Schema
>;

export type CreateM7CampaignSensorBindingV1Input = z.input<
  typeof campaignSensorBindingIdentitySchema
> & {
  readonly boundAt: string;
};

export const createM7CampaignSensorBindingV1 = (
  input: CreateM7CampaignSensorBindingV1Input,
): M7CampaignSensorBindingV1 => {
  const { boundAt, ...identityInput } = input;
  const identity = campaignSensorBindingIdentitySchema.parse(identityInput);
  const recordBasis = {
    ...identity,
    recordKind: "m7-campaign-sensor-binding" as const,
    campaignSensorBindingId: `m7-campaign-sensor-binding:${digestJson(identity).slice(0, 24)}`,
    boundAt: z.string().datetime().parse(boundAt),
  };
  return M7CampaignSensorBindingV1Schema.parse({
    ...recordBasis,
    recordContentSha256: digestJson(recordBasis),
  });
};

export const M7ArmV1Schema = z.enum(["runtime_enabled", "code_only"]);
export type M7ArmV1 = z.infer<typeof M7ArmV1Schema>;

const armOrderSchema = z.tuple([
  z.literal("runtime_enabled"),
  z.literal("code_only"),
]);

const mutationRegistrationIdentitySchema = z
  .object({
    schemaVersion: z.literal(1),
    campaignSensorBindingId: campaignSensorBindingIdSchema,
    campaignSensorBindingRecordSha256: Sha256DigestV1Schema,
    sensorFreezeId: sensorFreezeIdSchema,
    sensorFreezeRecordSha256: Sha256DigestV1Schema,
    mutationSha256: Sha256DigestV1Schema,
    mutatedBaselineSelectedTreeSha256: Sha256DigestV1Schema,
    mutatedBuildSourceIdentitySha256: Sha256DigestV1Schema,
    adapterMutantCompatibilityReceiptSha256: Sha256DigestV1Schema,
    publicTaskSpecSha256: Sha256DigestV1Schema,
    evaluatorImplementationSha256: Sha256DigestV1Schema,
    evaluatorBundleSha256: Sha256DigestV1Schema,
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
    runtimeGameToolSetSha256: Sha256DigestV1Schema,
    armOrder: armOrderSchema,
  })
  .strict();

const mutationRegistrationBaseSchema =
  mutationRegistrationIdentitySchema.extend({
    recordKind: z.literal("m7-mutation-registration"),
    campaignId: campaignIdSchema,
    registeredAt: z.string().datetime(),
    recordContentSha256: Sha256DigestV1Schema,
  });

export const M7MutationRegistrationV1Schema = mutationRegistrationBaseSchema
  .strict()
  .superRefine((value, context) => {
    const identity = mutationRegistrationIdentitySchema.parse({
      schemaVersion: value.schemaVersion,
      campaignSensorBindingId: value.campaignSensorBindingId,
      campaignSensorBindingRecordSha256:
        value.campaignSensorBindingRecordSha256,
      sensorFreezeId: value.sensorFreezeId,
      sensorFreezeRecordSha256: value.sensorFreezeRecordSha256,
      mutationSha256: value.mutationSha256,
      mutatedBaselineSelectedTreeSha256:
        value.mutatedBaselineSelectedTreeSha256,
      mutatedBuildSourceIdentitySha256: value.mutatedBuildSourceIdentitySha256,
      adapterMutantCompatibilityReceiptSha256:
        value.adapterMutantCompatibilityReceiptSha256,
      publicTaskSpecSha256: value.publicTaskSpecSha256,
      evaluatorImplementationSha256: value.evaluatorImplementationSha256,
      evaluatorBundleSha256: value.evaluatorBundleSha256,
      provider: value.provider,
      model: value.model,
      thinkingLevel: value.thinkingLevel,
      agentBudgetSha256: value.agentBudgetSha256,
      codingToolSetSha256: value.codingToolSetSha256,
      sandboxPolicySha256: value.sandboxPolicySha256,
      runtimeGameToolSetSha256: value.runtimeGameToolSetSha256,
      armOrder: value.armOrder,
    });
    const expectedId = `m7-campaign:${digestJson(identity).slice(0, 24)}`;
    if (value.campaignId !== expectedId) {
      addIssue(
        context,
        ["campaignId"],
        "campaign ID must derive from the frozen sensor, mutation, and paired protocol identities",
      );
    }
    validateContentHash(value, context);
  });
export type M7MutationRegistrationV1 = z.infer<
  typeof M7MutationRegistrationV1Schema
>;

export interface CreateM7MutationRegistrationV1Input extends Omit<
  z.input<typeof mutationRegistrationIdentitySchema>,
  | "schemaVersion"
  | "campaignSensorBindingId"
  | "campaignSensorBindingRecordSha256"
  | "sensorFreezeId"
  | "sensorFreezeRecordSha256"
  | "mutatedBuildSourceIdentitySha256"
  | "runtimeGameToolSetSha256"
  | "armOrder"
> {
  readonly mutatedBuildSourceIdentitySha256: M7BuildSourceIdentitySha256V1;
  readonly registeredAt: string;
}

export const createM7MutationRegistrationV1 = (input: {
  readonly sensorBinding: M7CampaignSensorBindingV1;
  readonly registration: CreateM7MutationRegistrationV1Input;
}): M7MutationRegistrationV1 => {
  const sensorBinding = M7CampaignSensorBindingV1Schema.parse(
    input.sensorBinding,
  );
  if (
    input.registration.mutatedBaselineSelectedTreeSha256 ===
    sensorBinding.pristineSelectedTreeSha256
  ) {
    throw new Error("M7 registered mutation must change the selected tree");
  }
  const { registeredAt, ...registrationIdentity } = input.registration;
  const identity = mutationRegistrationIdentitySchema.parse({
    schemaVersion: 1,
    campaignSensorBindingId: sensorBinding.campaignSensorBindingId,
    campaignSensorBindingRecordSha256: sensorBinding.recordContentSha256,
    sensorFreezeId: sensorBinding.authoritativeSensorFreezeId,
    sensorFreezeRecordSha256:
      sensorBinding.authoritativeSensorFreezeRecordSha256,
    ...registrationIdentity,
    runtimeGameToolSetSha256: sensorBinding.validatedGameToolSetSha256,
    armOrder: ["runtime_enabled", "code_only"],
  });
  const recordBasis = {
    ...identity,
    recordKind: "m7-mutation-registration" as const,
    campaignId: `m7-campaign:${digestJson(identity).slice(0, 24)}`,
    registeredAt: z.string().datetime().parse(registeredAt),
  };
  return M7MutationRegistrationV1Schema.parse({
    ...recordBasis,
    recordContentSha256: digestJson(recordBasis),
  });
};

const preflightInfrastructureFailureSchema = z.enum([
  "godot_unavailable",
  "fixture_failed",
  "runner_failed",
  "persistence_failed",
]);

const mutationPreflightBaseSchema = z.object({
  schemaVersion: z.literal(1),
  recordKind: z.literal("m7-mutation-preflight"),
  campaignId: campaignIdSchema,
  mutationRegistrationSha256: Sha256DigestV1Schema,
  pristinePassCount: z.number().int().min(0).max(9),
  mutantPublicAndHiddenPassCount: z.number().int().min(0).max(6),
  mutantRegressionPassCount: z.number().int().min(0).max(3),
  genericClassifierMutantWitnessObserved: z.boolean(),
  pristineAdapterConformancePassed: z.boolean(),
  mutantBuildCompatibilityPassed: z.boolean(),
  cleanupProven: z.boolean(),
  infrastructureFailureCode: preflightInfrastructureFailureSchema.nullable(),
  outcome: z.enum(["passed", "preflight_failed"]),
  completedAt: z.string().datetime(),
  recordContentSha256: Sha256DigestV1Schema,
});

const preflightPassed = (
  value: Pick<
    z.infer<typeof mutationPreflightBaseSchema>,
    | "pristinePassCount"
    | "mutantPublicAndHiddenPassCount"
    | "mutantRegressionPassCount"
    | "genericClassifierMutantWitnessObserved"
    | "pristineAdapterConformancePassed"
    | "mutantBuildCompatibilityPassed"
    | "cleanupProven"
    | "infrastructureFailureCode"
  >,
): boolean =>
  value.pristinePassCount === 9 &&
  value.mutantPublicAndHiddenPassCount === 0 &&
  value.mutantRegressionPassCount === 3 &&
  value.genericClassifierMutantWitnessObserved &&
  value.pristineAdapterConformancePassed &&
  value.mutantBuildCompatibilityPassed &&
  value.cleanupProven &&
  value.infrastructureFailureCode === null;

export const M7MutationPreflightReceiptV1Schema = mutationPreflightBaseSchema
  .strict()
  .superRefine((value, context) => {
    const expectedOutcome = preflightPassed(value)
      ? "passed"
      : "preflight_failed";
    if (value.outcome !== expectedOutcome) {
      addIssue(
        context,
        ["outcome"],
        "preflight outcome must derive from the frozen admission checks",
      );
    }
    validateContentHash(value, context);
  });
export type M7MutationPreflightReceiptV1 = z.infer<
  typeof M7MutationPreflightReceiptV1Schema
>;

export const createM7MutationPreflightReceiptV1 = (
  input: Omit<
    z.input<typeof mutationPreflightBaseSchema>,
    "schemaVersion" | "recordKind" | "outcome" | "recordContentSha256"
  >,
): M7MutationPreflightReceiptV1 => {
  const outcome = preflightPassed(input) ? "passed" : "preflight_failed";
  const recordBasis = {
    schemaVersion: 1 as const,
    recordKind: "m7-mutation-preflight" as const,
    ...input,
    outcome,
  };
  return M7MutationPreflightReceiptV1Schema.parse({
    ...recordBasis,
    recordContentSha256: digestJson(recordBasis),
  });
};

const pairedArmBindingSchema = z
  .object({
    publicTaskSpecSha256: Sha256DigestV1Schema,
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
    thinkingLevel: mutationRegistrationIdentitySchema.shape.thinkingLevel,
    agentBudgetSha256: Sha256DigestV1Schema,
    workspaceBaselineSelectedTreeSha256: Sha256DigestV1Schema,
    codingToolSetSha256: Sha256DigestV1Schema,
    sandboxPolicySha256: Sha256DigestV1Schema,
  })
  .strict();

const expectedPairedArmBinding = (
  registration: M7MutationRegistrationV1,
): z.infer<typeof pairedArmBindingSchema> =>
  pairedArmBindingSchema.parse({
    publicTaskSpecSha256: registration.publicTaskSpecSha256,
    provider: registration.provider,
    model: registration.model,
    thinkingLevel: registration.thinkingLevel,
    agentBudgetSha256: registration.agentBudgetSha256,
    workspaceBaselineSelectedTreeSha256:
      registration.mutatedBaselineSelectedTreeSha256,
    codingToolSetSha256: registration.codingToolSetSha256,
    sandboxPolicySha256: registration.sandboxPolicySha256,
  });

const armClaimBaseSchema = z.object({
  schemaVersion: z.literal(1),
  recordKind: z.literal("m7-arm-claim"),
  campaignId: campaignIdSchema,
  mutationRegistrationSha256: Sha256DigestV1Schema,
  arm: M7ArmV1Schema,
  armOrdinal: z.union([z.literal(1), z.literal(2)]),
  attemptOrdinal: z.literal(1),
  turnLimit: z.literal(1),
  binding: pairedArmBindingSchema,
  runtimeAccessEnabled: z.boolean(),
  gameToolSetSha256: Sha256DigestV1Schema.nullable(),
  taskId: safeIdentitySchema,
  sessionIdentitySha256: Sha256DigestV1Schema,
  workspaceIdentitySha256: Sha256DigestV1Schema,
  cacheIdentitySha256: Sha256DigestV1Schema,
  startedAt: z.string().datetime(),
  recordContentSha256: Sha256DigestV1Schema,
});

export const M7ArmClaimV1Schema = armClaimBaseSchema
  .strict()
  .superRefine((value, context) => {
    const runtimeEnabled = value.arm === "runtime_enabled";
    if (value.armOrdinal !== (runtimeEnabled ? 1 : 2)) {
      addIssue(context, ["armOrdinal"], "arm ordinal must match fixed order");
    }
    if (value.runtimeAccessEnabled !== runtimeEnabled) {
      addIssue(
        context,
        ["runtimeAccessEnabled"],
        "only the runtime_enabled arm may access runtime capabilities",
      );
    }
    if (runtimeEnabled !== (value.gameToolSetSha256 !== null)) {
      addIssue(
        context,
        ["gameToolSetSha256"],
        "runtime arm requires frozen game tools and code-only arm forbids them",
      );
    }
    validateContentHash(value, context);
  });
export type M7ArmClaimV1 = z.infer<typeof M7ArmClaimV1Schema>;

export interface BeginM7ArmOnceV1Input {
  readonly campaignId: string;
  readonly arm: M7ArmV1;
  readonly binding: z.input<typeof pairedArmBindingSchema>;
  readonly taskId: string;
  readonly sessionIdentitySha256: Sha256DigestV1;
  readonly workspaceIdentitySha256: Sha256DigestV1;
  readonly cacheIdentitySha256: Sha256DigestV1;
  readonly startedAt: string;
}

const createM7ArmClaimV1 = (input: {
  readonly registration: M7MutationRegistrationV1;
  readonly claim: BeginM7ArmOnceV1Input;
}): M7ArmClaimV1 => {
  const registration = M7MutationRegistrationV1Schema.parse(input.registration);
  const runtimeEnabled = input.claim.arm === "runtime_enabled";
  const recordBasis = {
    schemaVersion: 1 as const,
    recordKind: "m7-arm-claim" as const,
    campaignId: campaignIdSchema.parse(input.claim.campaignId),
    mutationRegistrationSha256: registration.recordContentSha256,
    arm: input.claim.arm,
    armOrdinal: runtimeEnabled ? (1 as const) : (2 as const),
    attemptOrdinal: 1 as const,
    turnLimit: 1 as const,
    binding: pairedArmBindingSchema.parse(input.claim.binding),
    runtimeAccessEnabled: runtimeEnabled,
    gameToolSetSha256: runtimeEnabled
      ? registration.runtimeGameToolSetSha256
      : null,
    taskId: safeIdentitySchema.parse(input.claim.taskId),
    sessionIdentitySha256: input.claim.sessionIdentitySha256,
    workspaceIdentitySha256: input.claim.workspaceIdentitySha256,
    cacheIdentitySha256: input.claim.cacheIdentitySha256,
    startedAt: z.string().datetime().parse(input.claim.startedAt),
  };
  return M7ArmClaimV1Schema.parse({
    ...recordBasis,
    recordContentSha256: digestJson(recordBasis),
  });
};

export const M7CandidatePatchV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    baselineSelectedTreeSha256: Sha256DigestV1Schema,
    candidateSelectedTreeSha256: Sha256DigestV1Schema,
    patchSha256: Sha256DigestV1Schema,
    byteLength: z
      .number()
      .int()
      .min(1)
      .max(512 * 1024 * 1024),
    roundTripVerified: z.literal(true),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.baselineSelectedTreeSha256 === value.candidateSelectedTreeSha256
    ) {
      addIssue(
        context,
        ["candidateSelectedTreeSha256"],
        "valid candidate tree must differ from its mutated baseline",
      );
    }
  });
export type M7CandidatePatchV1 = z.infer<typeof M7CandidatePatchV1Schema>;

export const M7FreshRunReferenceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    ordinal: z.number().int().min(1).max(9),
    scenarioClass: z.enum([
      "public_reproduction",
      "hidden_variant",
      "regression_control",
    ]),
    repetition: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    receiptSha256: Sha256DigestV1Schema,
  })
  .strict();
export type M7FreshRunReferenceV1 = z.infer<typeof M7FreshRunReferenceV1Schema>;

const expectedFreshRuns = (): readonly Omit<
  M7FreshRunReferenceV1,
  "schemaVersion" | "receiptSha256"
>[] => {
  const result: Array<
    Omit<M7FreshRunReferenceV1, "schemaVersion" | "receiptSha256">
  > = [];
  let ordinal = 1;
  for (const scenarioClass of [
    "public_reproduction",
    "hidden_variant",
    "regression_control",
  ] as const) {
    for (const repetition of [1, 2, 3] as const) {
      result.push({ ordinal, scenarioClass, repetition });
      ordinal += 1;
    }
  }
  return result;
};

const armResultBaseSchema = z.object({
  schemaVersion: z.literal(1),
  recordKind: z.literal("m7-arm-result"),
  campaignId: campaignIdSchema,
  arm: M7ArmV1Schema,
  armClaimSha256: Sha256DigestV1Schema,
  attemptOrdinal: z.literal(1),
  observedTurnCount: z.union([z.literal(0), z.literal(1)]),
  loopOutcome: z.enum([
    "completed",
    "provider_failure",
    "timed_out",
    "aborted",
    "infrastructure_failed",
  ]),
  candidateOutcome: z.enum([
    "no_candidate",
    "invalid_candidate",
    "valid_candidate",
  ]),
  candidate: M7CandidatePatchV1Schema.nullable(),
  runtimeUseOutcome: z.enum([
    "verified",
    "rejected",
    "missing",
    "infrastructure_failed",
    "not_applicable",
  ]),
  runtimeUseReceiptSha256: Sha256DigestV1Schema.nullable(),
  evaluatorOutcome: z.enum([
    "accepted",
    "rejected",
    "infrastructure_failed",
    "not_run_no_candidate",
    "not_run_invalid_candidate",
    "not_run_agent_failure",
  ]),
  evaluatorReceiptSha256: Sha256DigestV1Schema.nullable(),
  freshRunReferences: z.array(M7FreshRunReferenceV1Schema).max(9),
  cleanupProven: z.boolean(),
  cleanupReceiptSha256: Sha256DigestV1Schema.nullable(),
  completedAt: z.string().datetime(),
  recordContentSha256: Sha256DigestV1Schema,
});

export const M7ArmResultV1Schema = armResultBaseSchema
  .strict()
  .superRefine((value, context) => {
    const completed = value.loopOutcome === "completed";
    const validCandidate = value.candidateOutcome === "valid_candidate";
    if (
      value.observedTurnCount === 0 &&
      value.loopOutcome !== "infrastructure_failed"
    ) {
      addIssue(
        context,
        ["observedTurnCount"],
        "zero observed turns require a pre-turn infrastructure failure",
      );
    }
    if (validCandidate !== (value.candidate !== null)) {
      addIssue(
        context,
        ["candidate"],
        "only valid_candidate may retain a candidate patch identity",
      );
    }
    if (!completed && value.candidateOutcome !== "no_candidate") {
      addIssue(
        context,
        ["candidateOutcome"],
        "an incomplete Agent loop cannot contribute a candidate",
      );
    }

    if (value.arm === "code_only") {
      if (
        value.runtimeUseOutcome !== "not_applicable" ||
        value.runtimeUseReceiptSha256 !== null
      ) {
        addIssue(
          context,
          ["runtimeUseOutcome"],
          "code-only arm cannot claim or retain runtime-use evidence",
        );
      }
    } else {
      if (value.runtimeUseOutcome === "not_applicable") {
        addIssue(
          context,
          ["runtimeUseOutcome"],
          "runtime arm must record the independent runtime-use check",
        );
      }
      const receiptRequired =
        value.runtimeUseOutcome === "verified" ||
        value.runtimeUseOutcome === "rejected";
      if (receiptRequired && value.runtimeUseReceiptSha256 === null) {
        addIssue(
          context,
          ["runtimeUseReceiptSha256"],
          "verified/rejected runtime-use outcomes require their actual receipt",
        );
      }
    }

    const expectedEvaluatorOutcome = !completed
      ? "not_run_agent_failure"
      : value.candidateOutcome === "no_candidate"
        ? "not_run_no_candidate"
        : value.candidateOutcome === "invalid_candidate"
          ? "not_run_invalid_candidate"
          : null;
    if (
      expectedEvaluatorOutcome !== null &&
      value.evaluatorOutcome !== expectedEvaluatorOutcome
    ) {
      addIssue(
        context,
        ["evaluatorOutcome"],
        "evaluator non-run reason must derive from loop and candidate outcome",
      );
    }
    if (
      expectedEvaluatorOutcome === null &&
      !["accepted", "rejected", "infrastructure_failed"].includes(
        value.evaluatorOutcome,
      )
    ) {
      addIssue(
        context,
        ["evaluatorOutcome"],
        "every valid candidate must be evaluated",
      );
    }
    const evaluatorRan = [
      "accepted",
      "rejected",
      "infrastructure_failed",
    ].includes(value.evaluatorOutcome);
    if (evaluatorRan !== (value.evaluatorReceiptSha256 !== null)) {
      addIssue(
        context,
        ["evaluatorReceiptSha256"],
        "an evaluator outcome must retain exactly its evaluator receipt",
      );
    }
    if (
      (value.evaluatorOutcome === "accepted" ||
        value.evaluatorOutcome === "rejected") &&
      value.freshRunReferences.length !== 9
    ) {
      addIssue(
        context,
        ["freshRunReferences"],
        "accepted/rejected evaluation requires all nine fresh-run receipts",
      );
    }
    if (!evaluatorRan && value.freshRunReferences.length !== 0) {
      addIssue(
        context,
        ["freshRunReferences"],
        "an evaluator that did not run cannot retain fresh-run receipts",
      );
    }
    const plan = expectedFreshRuns();
    value.freshRunReferences.forEach((reference, index) => {
      const expected = plan[index];
      if (
        expected === undefined ||
        reference.ordinal !== expected.ordinal ||
        reference.scenarioClass !== expected.scenarioClass ||
        reference.repetition !== expected.repetition
      ) {
        addIssue(
          context,
          ["freshRunReferences", index],
          "fresh-run references must follow the canonical 3x3 order",
        );
      }
    });
    if (
      new Set(value.freshRunReferences.map((run) => run.receiptSha256)).size !==
      value.freshRunReferences.length
    ) {
      addIssue(
        context,
        ["freshRunReferences"],
        "fresh-run receipt references must be distinct",
      );
    }
    if (value.cleanupProven !== (value.cleanupReceiptSha256 !== null)) {
      addIssue(
        context,
        ["cleanupReceiptSha256"],
        "cleanup proof must retain exactly one cleanup receipt",
      );
    }
    validateContentHash(value, context);
  });
export type M7ArmResultV1 = z.infer<typeof M7ArmResultV1Schema>;

export const createM7ArmResultV1 = (
  input: Omit<
    z.input<typeof armResultBaseSchema>,
    "schemaVersion" | "recordKind" | "attemptOrdinal" | "recordContentSha256"
  >,
): M7ArmResultV1 => {
  const recordBasis = {
    schemaVersion: 1 as const,
    recordKind: "m7-arm-result" as const,
    ...input,
    attemptOrdinal: 1 as const,
  };
  return M7ArmResultV1Schema.parse({
    ...recordBasis,
    recordContentSha256: digestJson(recordBasis),
  });
};

export const M7CampaignTerminalOutcomeV1Schema = z.enum([
  "claim_supported",
  "claim_not_supported",
  "comparison_inconclusive",
  "infrastructure_failure",
  "cleanup_failed",
]);
export type M7CampaignTerminalOutcomeV1 = z.infer<
  typeof M7CampaignTerminalOutcomeV1Schema
>;

export const M7CampaignTerminalReasonV1Schema = z.enum([
  "runtime_advantage_observed",
  "code_only_candidate_accepted",
  "runtime_treatment_not_accepted",
  "runtime_use_not_verified",
  "agent_attempt_inconclusive",
  "preflight_failed",
  "arm_infrastructure_failed",
  "evaluator_infrastructure_failed",
  "cleanup_not_proven",
]);
export type M7CampaignTerminalReasonV1 = z.infer<
  typeof M7CampaignTerminalReasonV1Schema
>;

export interface M7CampaignOutcomeDerivationV1 {
  readonly outcome: M7CampaignTerminalOutcomeV1;
  readonly reason: M7CampaignTerminalReasonV1;
  readonly primaryOutcome: Exclude<
    M7CampaignTerminalOutcomeV1,
    "cleanup_failed"
  > | null;
  readonly primaryReason: Exclude<
    M7CampaignTerminalReasonV1,
    "cleanup_not_proven"
  > | null;
}

type CampaignPrimaryDerivation = Readonly<{
  outcome: Exclude<M7CampaignTerminalOutcomeV1, "cleanup_failed">;
  reason: Exclude<M7CampaignTerminalReasonV1, "cleanup_not_proven">;
}>;

const deriveM7CampaignPrimaryOutcomeV1 = (input: {
  readonly preflight: M7MutationPreflightReceiptV1;
  readonly runtimeEnabled: M7ArmResultV1 | null;
  readonly codeOnly: M7ArmResultV1 | null;
  readonly tolerateMissingArmAfterCleanupFailure: boolean;
}): CampaignPrimaryDerivation => {
  const { preflight, runtimeEnabled: runtime, codeOnly } = input;
  if (preflight.outcome === "preflight_failed") {
    return { outcome: "infrastructure_failure", reason: "preflight_failed" };
  }
  if (runtime === null) {
    if (input.tolerateMissingArmAfterCleanupFailure) {
      return {
        outcome: "comparison_inconclusive",
        reason: "agent_attempt_inconclusive",
      };
    }
    throw new Error("passed preflight requires a runtime-enabled arm result");
  }
  if (
    runtime.loopOutcome === "infrastructure_failed" ||
    runtime.runtimeUseOutcome === "infrastructure_failed"
  ) {
    return {
      outcome: "infrastructure_failure",
      reason: "arm_infrastructure_failed",
    };
  }
  if (runtime.evaluatorOutcome === "infrastructure_failed") {
    return {
      outcome: "infrastructure_failure",
      reason: "evaluator_infrastructure_failed",
    };
  }
  if (codeOnly === null && !input.tolerateMissingArmAfterCleanupFailure) {
    throw new Error(
      "a cleaned non-infrastructure runtime arm requires the fixed code-only arm regardless of its outcome",
    );
  }
  if (runtime.loopOutcome !== "completed") {
    return {
      outcome: "comparison_inconclusive",
      reason: "agent_attempt_inconclusive",
    };
  }
  if (runtime.runtimeUseOutcome !== "verified") {
    return {
      outcome: "claim_not_supported",
      reason: "runtime_use_not_verified",
    };
  }
  if (
    runtime.candidateOutcome !== "valid_candidate" ||
    runtime.evaluatorOutcome !== "accepted"
  ) {
    return {
      outcome: "claim_not_supported",
      reason: "runtime_treatment_not_accepted",
    };
  }
  if (codeOnly === null) {
    return {
      outcome: "comparison_inconclusive",
      reason: "agent_attempt_inconclusive",
    };
  }
  if (codeOnly.loopOutcome === "infrastructure_failed") {
    return {
      outcome: "infrastructure_failure",
      reason: "arm_infrastructure_failed",
    };
  }
  if (codeOnly.evaluatorOutcome === "infrastructure_failed") {
    return {
      outcome: "infrastructure_failure",
      reason: "evaluator_infrastructure_failed",
    };
  }
  if (codeOnly.loopOutcome !== "completed") {
    return {
      outcome: "comparison_inconclusive",
      reason: "agent_attempt_inconclusive",
    };
  }
  if (codeOnly.evaluatorOutcome === "accepted") {
    return {
      outcome: "claim_not_supported",
      reason: "code_only_candidate_accepted",
    };
  }
  return {
    outcome: "claim_supported",
    reason: "runtime_advantage_observed",
  };
};

export const deriveM7CampaignOutcomeV1 = (input: {
  readonly preflight: M7MutationPreflightReceiptV1;
  readonly runtimeEnabled: M7ArmResultV1 | null;
  readonly codeOnly: M7ArmResultV1 | null;
}): M7CampaignOutcomeDerivationV1 => {
  const preflight = M7MutationPreflightReceiptV1Schema.parse(input.preflight);
  const runtime =
    input.runtimeEnabled === null
      ? null
      : M7ArmResultV1Schema.parse(input.runtimeEnabled);
  const codeOnly =
    input.codeOnly === null ? null : M7ArmResultV1Schema.parse(input.codeOnly);
  if (runtime !== null && runtime.arm !== "runtime_enabled") {
    throw new Error("runtimeEnabled result belongs to the wrong arm");
  }
  if (codeOnly !== null && codeOnly.arm !== "code_only") {
    throw new Error("codeOnly result belongs to the wrong arm");
  }

  const cleanupFailed =
    !preflight.cleanupProven ||
    (runtime !== null && !runtime.cleanupProven) ||
    (codeOnly !== null && !codeOnly.cleanupProven);
  const primary = deriveM7CampaignPrimaryOutcomeV1({
    preflight,
    runtimeEnabled: runtime,
    codeOnly,
    tolerateMissingArmAfterCleanupFailure: cleanupFailed,
  });
  if (cleanupFailed) {
    return {
      outcome: "cleanup_failed",
      reason: "cleanup_not_proven",
      primaryOutcome: primary.outcome,
      primaryReason: primary.reason,
    };
  }
  return {
    ...primary,
    primaryOutcome: null,
    primaryReason: null,
  };
};

const terminalRecordBaseSchema = z.object({
  schemaVersion: z.literal(1),
  recordKind: z.literal("m7-campaign-terminal"),
  campaignId: campaignIdSchema,
  outcome: M7CampaignTerminalOutcomeV1Schema,
  reason: M7CampaignTerminalReasonV1Schema,
  primaryOutcome: M7CampaignTerminalOutcomeV1Schema.exclude([
    "cleanup_failed",
  ]).nullable(),
  primaryReason: M7CampaignTerminalReasonV1Schema.exclude([
    "cleanup_not_proven",
  ]).nullable(),
  preflightReceiptSha256: Sha256DigestV1Schema,
  runtimeEnabledResultSha256: Sha256DigestV1Schema.nullable(),
  codeOnlyResultSha256: Sha256DigestV1Schema.nullable(),
  completedAt: z.string().datetime(),
  recordContentSha256: Sha256DigestV1Schema,
});

export const M7CampaignTerminalRecordV1Schema = terminalRecordBaseSchema
  .strict()
  .superRefine((value, context) => {
    const retainsPrimary =
      value.primaryOutcome !== null && value.primaryReason !== null;
    if ((value.outcome === "cleanup_failed") !== retainsPrimary) {
      addIssue(
        context,
        ["primaryOutcome"],
        "cleanup_failed must retain its prior primary outcome and reason; other outcomes must not",
      );
    }
    validateContentHash(value, context);
  });
export type M7CampaignTerminalRecordV1 = z.infer<
  typeof M7CampaignTerminalRecordV1Schema
>;

export const createM7CampaignTerminalRecordV1 = (input: {
  readonly campaignId: string;
  readonly preflight: M7MutationPreflightReceiptV1;
  readonly runtimeEnabled: M7ArmResultV1 | null;
  readonly codeOnly: M7ArmResultV1 | null;
  readonly completedAt: string;
}): M7CampaignTerminalRecordV1 => {
  const derivation = deriveM7CampaignOutcomeV1(input);
  const recordBasis = {
    schemaVersion: 1 as const,
    recordKind: "m7-campaign-terminal" as const,
    campaignId: campaignIdSchema.parse(input.campaignId),
    ...derivation,
    preflightReceiptSha256: input.preflight.recordContentSha256,
    runtimeEnabledResultSha256:
      input.runtimeEnabled?.recordContentSha256 ?? null,
    codeOnlyResultSha256: input.codeOnly?.recordContentSha256 ?? null,
    completedAt: z.string().datetime().parse(input.completedAt),
  };
  return M7CampaignTerminalRecordV1Schema.parse({
    ...recordBasis,
    recordContentSha256: digestJson(recordBasis),
  });
};

type RecordKind =
  | "sensor-binding"
  | "mutation-registration"
  | "preflight"
  | "runtime-enabled-claim"
  | "runtime-enabled-result"
  | "code-only-claim"
  | "code-only-result"
  | "terminal";

const recordName = (kind: RecordKind): string => `m7.${kind}.json`;

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

const requireEffectiveUserId = (): number => {
  const uid = process.geteuid?.();
  if (uid === undefined) {
    throw new Error("M7 Host-only store requires effective-user checks");
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

export class M7RuntimeUseCampaignStoreV1 {
  readonly #root: string;
  readonly #identity: PrivateRootIdentity;

  private constructor(root: string, identity: PrivateRootIdentity) {
    this.#root = root;
    this.#identity = identity;
  }

  public static async open(input: {
    readonly root: string;
    readonly exposedRoots: readonly string[];
  }): Promise<M7RuntimeUseCampaignStoreV1> {
    const { canonical: root, metadata } = await canonicalDirectory(
      input.root,
      "M7 Host-only root",
    );
    if (
      metadata.uid !== requireEffectiveUserId() ||
      (metadata.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE
    ) {
      throw new Error(
        "M7 Host-only root must be owned by the current user with mode 0700",
      );
    }
    for (const [index, exposedRoot] of input.exposedRoots.entries()) {
      const { canonical: exposed } = await canonicalDirectory(
        exposedRoot,
        `M7 exposed root ${index + 1}`,
      );
      if (
        pathWithinOrEqual(root, exposed) ||
        pathWithinOrEqual(exposed, root)
      ) {
        throw new Error(
          "M7 Host-only root must be disjoint from Agent-exposed roots",
        );
      }
    }
    return new M7RuntimeUseCampaignStoreV1(root, {
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
      throw new Error("M7 Host-only root identity changed");
    }
  }

  #path(kind: RecordKind): string {
    return resolve(this.#root, recordName(kind));
  }

  async #writeOnce(kind: RecordKind, value: unknown): Promise<void> {
    await this.#requireRoot();
    const bytes = Buffer.from(
      `${canonicalJson(JsonValueSchema.parse(value))}\n`,
    );
    if (bytes.byteLength > RECORD_BYTE_LIMIT) {
      throw new Error("M7 private record exceeds its byte limit");
    }
    try {
      await publishPrivateFileOnceV1({
        root: this.#root,
        filename: recordName(kind),
        bytes,
      });
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new Error(
          `M7 ${kind} already exists; retries, rerolls, and overwrites are forbidden`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async #read<T>(kind: RecordKind, parse: (value: unknown) => T): Promise<T> {
    await this.#requireRoot();
    const path = this.#path(kind);
    const metadata = await lstat(path);
    if (!pathWithinOrEqual(this.#root, path)) {
      throw new Error("M7 private record escaped its root");
    }
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.uid !== requireEffectiveUserId() ||
      (metadata.mode & 0o7777) !== PRIVATE_FILE_MODE ||
      (await realpath(path)) !== path ||
      metadata.size > RECORD_BYTE_LIMIT
    ) {
      throw new Error(
        "M7 private record must remain a canonical one-link owned mode-0600 regular file",
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
        throw new Error("M7 private record identity changed while opening");
      }
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await handle.readFile(),
          ),
        );
      } catch (error) {
        throw new Error("M7 private record is not valid UTF-8 JSON", {
          cause: error,
        });
      }
      return parse(value);
    } finally {
      await handle.close();
    }
  }

  public async bindCampaignSensorOnce(
    input: CreateM7CampaignSensorBindingV1Input,
  ): Promise<M7CampaignSensorBindingV1> {
    const record = createM7CampaignSensorBindingV1(input);
    await this.#writeOnce("sensor-binding", record);
    return record;
  }

  public readCampaignSensorBinding(): Promise<M7CampaignSensorBindingV1> {
    return this.#read("sensor-binding", (value) =>
      M7CampaignSensorBindingV1Schema.parse(value),
    );
  }

  public async registerMutationOnce(
    input: CreateM7MutationRegistrationV1Input,
  ): Promise<M7MutationRegistrationV1> {
    let sensorBinding: M7CampaignSensorBindingV1;
    try {
      sensorBinding = await this.readCampaignSensorBinding();
    } catch (error) {
      throw new Error(
        "M7 mutation registration requires the create-once authoritative sensor binding",
        { cause: error },
      );
    }
    const registration = createM7MutationRegistrationV1({
      sensorBinding,
      registration: input,
    });
    await this.#writeOnce("mutation-registration", registration);
    return registration;
  }

  public async readMutationRegistration(): Promise<M7MutationRegistrationV1> {
    const registration = await this.#read("mutation-registration", (value) =>
      M7MutationRegistrationV1Schema.parse(value),
    );
    const sensorBinding = await this.readCampaignSensorBinding();
    if (
      registration.campaignSensorBindingId !==
        sensorBinding.campaignSensorBindingId ||
      registration.campaignSensorBindingRecordSha256 !==
        sensorBinding.recordContentSha256 ||
      registration.sensorFreezeId !==
        sensorBinding.authoritativeSensorFreezeId ||
      registration.sensorFreezeRecordSha256 !==
        sensorBinding.authoritativeSensorFreezeRecordSha256 ||
      registration.runtimeGameToolSetSha256 !==
        sensorBinding.validatedGameToolSetSha256 ||
      registration.mutatedBaselineSelectedTreeSha256 ===
        sensorBinding.pristineSelectedTreeSha256
    ) {
      throw new Error(
        "M7 mutation registration crossed its authoritative sensor binding or source identities",
      );
    }
    return registration;
  }

  public async putPreflightOnce(
    input: Omit<
      z.input<typeof mutationPreflightBaseSchema>,
      | "schemaVersion"
      | "recordKind"
      | "outcome"
      | "recordContentSha256"
      | "campaignId"
      | "mutationRegistrationSha256"
    >,
  ): Promise<M7MutationPreflightReceiptV1> {
    const registration = await this.readMutationRegistration();
    const receipt = createM7MutationPreflightReceiptV1({
      ...input,
      campaignId: registration.campaignId,
      mutationRegistrationSha256: registration.recordContentSha256,
    });
    await this.#writeOnce("preflight", receipt);
    return receipt;
  }

  public async readPreflight(): Promise<M7MutationPreflightReceiptV1> {
    const preflight = await this.#read("preflight", (value) =>
      M7MutationPreflightReceiptV1Schema.parse(value),
    );
    const registration = await this.readMutationRegistration();
    if (
      preflight.campaignId !== registration.campaignId ||
      preflight.mutationRegistrationSha256 !== registration.recordContentSha256
    ) {
      throw new Error("M7 preflight crossed its mutation registration");
    }
    return preflight;
  }

  public async beginArmOnce(
    input: BeginM7ArmOnceV1Input,
  ): Promise<M7ArmClaimV1> {
    const [registration, preflight] = await Promise.all([
      this.readMutationRegistration(),
      this.readPreflight(),
    ]);
    if (
      input.campaignId !== registration.campaignId ||
      preflight.campaignId !== registration.campaignId ||
      preflight.mutationRegistrationSha256 !== registration.recordContentSha256
    ) {
      throw new Error("M7 arm crossed its registered campaign identities");
    }
    if (preflight.outcome !== "passed") {
      throw new Error("M7 Agent arms cannot start after preflight_failed");
    }
    const expectedBinding = expectedPairedArmBinding(registration);
    const actualBinding = pairedArmBindingSchema.parse(input.binding);
    if (canonicalJson(actualBinding) !== canonicalJson(expectedBinding)) {
      throw new Error(
        "M7 paired arms must use the exact frozen prompt, provider, model, budget, baseline, coding tools, and sandbox policy",
      );
    }
    if (input.arm === "runtime_enabled") {
      try {
        await this.readArmClaim("code_only");
        throw new Error("M7 runtime arm cannot start after code-only arm");
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "M7 runtime arm cannot start after code-only arm"
        ) {
          throw error;
        }
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
      }
    } else {
      let runtimeResult: M7ArmResultV1;
      try {
        runtimeResult = await this.readArmResult("runtime_enabled");
      } catch (error) {
        throw new Error(
          "M7 code-only arm requires the completed runtime-enabled arm first",
          { cause: error },
        );
      }
      if (!runtimeResult.cleanupProven) {
        throw new Error("M7 code-only arm requires proven runtime-arm cleanup");
      }
      const runtimeClaim = await this.readArmClaim("runtime_enabled");
      for (const [label, runtimeIdentity, codeIdentity] of [
        [
          "session",
          runtimeClaim.sessionIdentitySha256,
          input.sessionIdentitySha256,
        ],
        [
          "workspace",
          runtimeClaim.workspaceIdentitySha256,
          input.workspaceIdentitySha256,
        ],
        ["cache", runtimeClaim.cacheIdentitySha256, input.cacheIdentitySha256],
      ] as const) {
        if (runtimeIdentity === codeIdentity) {
          throw new Error(
            `M7 paired arms require isolated ${label} identities`,
          );
        }
      }
    }
    const claim = createM7ArmClaimV1({ registration, claim: input });
    await this.#writeOnce(
      input.arm === "runtime_enabled"
        ? "runtime-enabled-claim"
        : "code-only-claim",
      claim,
    );
    return claim;
  }

  public async readArmClaim(arm: M7ArmV1): Promise<M7ArmClaimV1> {
    const claim = await this.#read(
      arm === "runtime_enabled" ? "runtime-enabled-claim" : "code-only-claim",
      (value) => {
        const claim = M7ArmClaimV1Schema.parse(value);
        if (claim.arm !== arm) {
          throw new Error("M7 stored arm claim crossed its arm");
        }
        return claim;
      },
    );
    const registration = await this.readMutationRegistration();
    if (
      claim.campaignId !== registration.campaignId ||
      claim.mutationRegistrationSha256 !== registration.recordContentSha256 ||
      canonicalJson(claim.binding) !==
        canonicalJson(expectedPairedArmBinding(registration)) ||
      claim.gameToolSetSha256 !==
        (arm === "runtime_enabled"
          ? registration.runtimeGameToolSetSha256
          : null)
    ) {
      throw new Error("M7 arm claim crossed its frozen campaign binding");
    }
    if (arm === "code_only") {
      const runtimeClaim = await this.readArmClaim("runtime_enabled");
      if (
        runtimeClaim.sessionIdentitySha256 === claim.sessionIdentitySha256 ||
        runtimeClaim.workspaceIdentitySha256 ===
          claim.workspaceIdentitySha256 ||
        runtimeClaim.cacheIdentitySha256 === claim.cacheIdentitySha256
      ) {
        throw new Error("M7 persisted paired arms are not isolated");
      }
    }
    return claim;
  }

  public async putArmResultOnce(resultInput: M7ArmResultV1): Promise<void> {
    const result = M7ArmResultV1Schema.parse(resultInput);
    const [registration, claim] = await Promise.all([
      this.readMutationRegistration(),
      this.readArmClaim(result.arm),
    ]);
    if (
      result.campaignId !== registration.campaignId ||
      result.armClaimSha256 !== claim.recordContentSha256 ||
      (result.candidate !== null &&
        result.candidate.baselineSelectedTreeSha256 !==
          registration.mutatedBaselineSelectedTreeSha256)
    ) {
      throw new Error("M7 arm result crossed its campaign, claim, or baseline");
    }
    await this.#writeOnce(
      result.arm === "runtime_enabled"
        ? "runtime-enabled-result"
        : "code-only-result",
      result,
    );
  }

  public async readArmResult(arm: M7ArmV1): Promise<M7ArmResultV1> {
    const result = await this.#read(
      arm === "runtime_enabled" ? "runtime-enabled-result" : "code-only-result",
      (value) => {
        const result = M7ArmResultV1Schema.parse(value);
        if (result.arm !== arm) {
          throw new Error("M7 stored arm result crossed its arm");
        }
        return result;
      },
    );
    const [registration, claim] = await Promise.all([
      this.readMutationRegistration(),
      this.readArmClaim(arm),
    ]);
    if (
      result.campaignId !== registration.campaignId ||
      result.armClaimSha256 !== claim.recordContentSha256 ||
      (result.candidate !== null &&
        result.candidate.baselineSelectedTreeSha256 !==
          registration.mutatedBaselineSelectedTreeSha256)
    ) {
      throw new Error("M7 stored arm result crossed its campaign binding");
    }
    return result;
  }

  public async finalizeCampaignOnce(
    completedAt: string,
  ): Promise<M7CampaignTerminalRecordV1> {
    const [registration, preflight] = await Promise.all([
      this.readMutationRegistration(),
      this.readPreflight(),
    ]);
    const readOptionalArm = async (
      arm: M7ArmV1,
    ): Promise<M7ArmResultV1 | null> => {
      try {
        return await this.readArmResult(arm);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return null;
        throw error;
      }
    };
    const [runtimeEnabled, codeOnly] = await Promise.all([
      readOptionalArm("runtime_enabled"),
      readOptionalArm("code_only"),
    ]);
    for (const result of [runtimeEnabled, codeOnly]) {
      if (result !== null && result.campaignId !== registration.campaignId) {
        throw new Error("M7 terminal crossed an arm result campaign");
      }
    }
    const terminal = createM7CampaignTerminalRecordV1({
      campaignId: registration.campaignId,
      preflight,
      runtimeEnabled,
      codeOnly,
      completedAt,
    });
    await this.#writeOnce("terminal", terminal);
    return terminal;
  }

  public readTerminal(): Promise<M7CampaignTerminalRecordV1> {
    return this.#read("terminal", (value) =>
      M7CampaignTerminalRecordV1Schema.parse(value),
    );
  }
}

export const openM7RuntimeUseCampaignStoreV1 = (
  input: Parameters<typeof M7RuntimeUseCampaignStoreV1.open>[0],
): Promise<M7RuntimeUseCampaignStoreV1> =>
  M7RuntimeUseCampaignStoreV1.open(input);
