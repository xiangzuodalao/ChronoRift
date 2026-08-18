import { createHash } from "node:crypto";

import { PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1 } from "@chronorift/agent-protocol";
import {
  JsonValueSchema,
  ProjectAdapterRevisionV1Schema,
  Sha256DigestV1Schema,
  asSha256DigestV1,
  type ProjectAdapterRevisionV1,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import {
  VNEXT_PI_FAILURE_CATEGORIES,
  VNEXT_PI_FAILURE_STAGES,
  VNEXT_PI_LIFECYCLE_STAGES,
  VNextPiTurnFailure,
  parseVNextPiHostHttpTransportObservationV1,
  projectVNextPiFailureV1,
  type VNextPiHostHttpTransportObservationV1,
  type VNextPiLifecycleEventV1,
} from "@chronorift/pi-harness";
import { z } from "zod";

import {
  ExternalHiddenFixPatchIdentityV1Schema,
  ExternalHiddenFixPatchReferenceV1Schema,
} from "./external-hidden-fix.js";
import {
  ExternalHiddenFixHostSourceObservationV1Schema,
  ExternalHiddenFixPublicExecutionEvidenceV1Schema,
} from "./external-hidden-fix-workflow.js";
import {
  createM6AdmittedGameToolsV1,
  type M6AdmittedGameToolV1,
} from "./m6-one-turn-agent.js";
import {
  M7AgentAttemptCleanupEvidenceV1Schema,
  M7AgentAttemptEvidenceCodeV1Schema,
  M7AgentAttemptEvidenceStageV1Schema,
  M7AgentAttemptPiStatsV1Schema,
  M7AgentArmIsolationV1Schema,
  M7AgentVisibleGameToolExchangeHashV1Schema,
  M7CodingToolSurfaceEntryV1Schema,
  M7PairedAgentBudgetV1Schema,
  M7PairedAgentCleanupResultV1Schema,
  M7RuntimeResourceMapV1Schema,
  createM7NeutralRuntimeResourceAppendixV1,
  type M7AgentArmIsolationV1,
  type M7PairedAgentCleanupResultV1,
  type M7AgentAttemptEvidenceStageV1,
  type M7RuntimeResourceMapV1,
} from "./m7-paired-agent.js";
import {
  M7PatrolTrajectoryClassifierConfigV1Schema,
  M7R3PatrolTrajectoryCaseSpecV1Schema,
  M7R3PatrolTrajectoryExecutionSummaryV1Schema,
  M7_PATROL_TRAJECTORY_CLASSIFIER_ID_V1,
} from "./m7-patrol-trajectory.js";

const campaignIdSchema = z.string().regex(/^m7-campaign:[a-f0-9]{24}$/u);
const portfolioIdSchema = z.string().regex(/^m7-r3-portfolio:[a-f0-9]{24}$/u);
const portfolioCaseIdSchema = z.string().regex(/^m7-r3-case:[a-f0-9]{24}$/u);
const trajectoryCaseIdSchema = z
  .string()
  .regex(/^m7-r3-trajectory-case:[a-f0-9]{24}$/u);
const caseOrdinalSchema = z.union([z.literal(1), z.literal(2)]);
const armSchema = z.enum(["runtime_enabled", "code_only"]);
const thinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const opaqueIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u);
const toolNameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

const piLifecycleStageSchema = z.enum(VNEXT_PI_LIFECYCLE_STAGES);
const piLifecycleEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    ordinal: z.number().int().min(1).max(VNEXT_PI_LIFECYCLE_STAGES.length),
    stage: piLifecycleStageSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ordinal !== VNEXT_PI_LIFECYCLE_STAGES.indexOf(value.stage) + 1) {
      addIssue(
        context,
        ["ordinal"],
        "Pi lifecycle ordinal does not match its fixed stage",
      );
    }
  });

const attemptFailureStageSchema = z.enum([
  ...VNEXT_PI_FAILURE_STAGES,
  "arm_run",
  "arm_result_validation",
  "arm_cleanup",
  "attempt_evidence_seal",
]);

const attemptFailureProjectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    stage: attemptFailureStageSchema,
    category: z.enum(VNEXT_PI_FAILURE_CATEGORIES),
    errorName: z.string().min(1).max(64),
    platformCode: z.string().min(1).max(32).nullable(),
    syscall: z.string().min(1).max(32).nullable(),
    messageSha256: Sha256DigestV1Schema,
    causeSha256s: z.array(Sha256DigestV1Schema).max(3),
  })
  .strict();

const piHostHttpTransportObservationSchema = z
  .unknown()
  .transform((value, context): VNextPiHostHttpTransportObservationV1 => {
    try {
      return parseVNextPiHostHttpTransportObservationV1(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Pi Host HTTP transport observation is invalid",
      });
      return z.NEVER;
    }
  });

export type M7R3PairedAgentArmV1 = z.infer<typeof armSchema>;

const hashBytes = (bytes: string | Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

const hashJson = (value: unknown): Sha256DigestV1 =>
  hashBytes(canonicalJson(JsonValueSchema.parse(value)));

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((entry) => right.includes(entry));

const addIssue = (
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  message: string,
): void => context.addIssue({ code: "custom", path: [...path], message });

const deepFreeze = <T>(value: T): Readonly<T> => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const naturalPromptBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-natural-user-prompt"),
    text: z
      .string()
      .min(1)
      .max(16_384)
      .refine(
        (value) => !value.includes("\u0000"),
        "prompt cannot contain NUL",
      ),
    utf8ByteLength: z.number().int().min(1).max(65_536),
    utf8Sha256: Sha256DigestV1Schema,
    canonicalJsonSha256: Sha256DigestV1Schema,
  })
  .strict();

/** Exact natural-user bytes shared by both arms of one R3 case. */
export const M7R3NaturalUserPromptV1Schema =
  naturalPromptBasisSchema.superRefine((value, context) => {
    const bytes = Buffer.from(value.text, "utf8");
    if (value.utf8ByteLength !== bytes.byteLength) {
      addIssue(
        context,
        ["utf8ByteLength"],
        "natural prompt UTF-8 byte length does not match",
      );
    }
    if (value.utf8Sha256 !== hashBytes(bytes)) {
      addIssue(
        context,
        ["utf8Sha256"],
        "natural prompt raw UTF-8 hash does not match",
      );
    }
    if (value.canonicalJsonSha256 !== hashJson(value.text)) {
      addIssue(
        context,
        ["canonicalJsonSha256"],
        "natural prompt canonical JSON hash does not match",
      );
    }
  });
export type M7R3NaturalUserPromptV1 = z.infer<
  typeof M7R3NaturalUserPromptV1Schema
>;

export const createM7R3NaturalUserPromptV1 = (
  text: string,
): M7R3NaturalUserPromptV1 => {
  const bytes = Buffer.from(text, "utf8");
  return deepFreeze(
    M7R3NaturalUserPromptV1Schema.parse({
      schemaVersion: 1,
      recordKind: "m7-r3-natural-user-prompt",
      text,
      utf8ByteLength: bytes.byteLength,
      utf8Sha256: hashBytes(bytes),
      canonicalJsonSha256: hashJson(text),
    }),
  );
};

const agentConfigurationSchema = z
  .object({
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
    thinkingLevel: thinkingLevelSchema,
    agentBudgetSha256: Sha256DigestV1Schema,
    codingToolSetSha256: Sha256DigestV1Schema,
    sandboxPolicySha256: Sha256DigestV1Schema,
  })
  .strict();

const commonRuntimeMaterialsSchema = z
  .object({
    authoritativeSensorFreezeRecordSha256: Sha256DigestV1Schema,
    trajectoryClassifierFreezeRecordSha256: Sha256DigestV1Schema,
    trajectoryClassifierImplementationSha256: Sha256DigestV1Schema,
    trajectoryClassifierConfigSha256: Sha256DigestV1Schema,
    adapterRevisionSha256: Sha256DigestV1Schema,
    adapterPackageSha256: Sha256DigestV1Schema,
    adapterObservationSchemaSha256: Sha256DigestV1Schema,
    pristineAdapterConformanceReceiptSha256: Sha256DigestV1Schema,
    validatedGameToolSetSha256: Sha256DigestV1Schema,
    commonEnvironmentInstructionsSha256: Sha256DigestV1Schema,
    hostModelRuntimeConfigSha256: Sha256DigestV1Schema,
  })
  .strict();

const pairedCaseContractBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-paired-case-contract"),
    portfolioId: portfolioIdSchema,
    caseOrdinal: caseOrdinalSchema,
    caseId: portfolioCaseIdSchema,
    mutatedBaselineSelectedTreeSha256: Sha256DigestV1Schema,
    naturalPrompt: M7R3NaturalUserPromptV1Schema,
    pairedAgentProtocolImplementationSha256: Sha256DigestV1Schema,
    pairedPublicTaskContractSha256: Sha256DigestV1Schema,
    runtimeArmPublicTaskSpecSha256: Sha256DigestV1Schema,
    codeOnlyArmPublicTaskSpecSha256: Sha256DigestV1Schema,
    adapterMutantCompatibilityReceiptSha256: Sha256DigestV1Schema,
    commonRuntimeMaterials: commonRuntimeMaterialsSchema,
    agentConfiguration: agentConfigurationSchema,
    trajectoryClassifierConfig: M7PatrolTrajectoryClassifierConfigV1Schema,
    trajectoryCaseSpec: M7R3PatrolTrajectoryCaseSpecV1Schema,
  })
  .strict();

/**
 * Static protocol projection bound by the separate Host-only campaign
 * admission. It deliberately is not an admission or an admission store.
 */
export const M7R3PairedCaseContractV1Schema = pairedCaseContractBasisSchema
  .extend({ pairedCaseContractContentSha256: Sha256DigestV1Schema })
  .strict()
  .superRefine((value, context) => {
    if (
      value.commonRuntimeMaterials.trajectoryClassifierImplementationSha256 !==
        value.trajectoryCaseSpec.classifierImplementationSha256 ||
      value.commonRuntimeMaterials.trajectoryClassifierConfigSha256 !==
        value.trajectoryCaseSpec.classifierConfigSha256 ||
      value.commonRuntimeMaterials.trajectoryClassifierConfigSha256 !==
        value.trajectoryClassifierConfig.configSha256
    ) {
      addIssue(
        context,
        ["trajectoryCaseSpec"],
        "trajectory implementation/config/case-spec identities crossed",
      );
    }
    const { pairedCaseContractContentSha256, ...basis } = value;
    if (pairedCaseContractContentSha256 !== hashJson(basis)) {
      addIssue(
        context,
        ["pairedCaseContractContentSha256"],
        "R3 paired-case contract content hash does not match",
      );
    }
  });
export type M7R3PairedCaseContractV1 = z.infer<
  typeof M7R3PairedCaseContractV1Schema
>;

export type CreateM7R3PairedCaseContractV1Input = Omit<
  z.input<typeof pairedCaseContractBasisSchema>,
  "schemaVersion" | "recordKind"
>;

export const createM7R3PairedCaseContractV1 = (
  input: CreateM7R3PairedCaseContractV1Input,
): M7R3PairedCaseContractV1 => {
  const basis = pairedCaseContractBasisSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-r3-paired-case-contract",
    ...input,
  });
  return deepFreeze(
    M7R3PairedCaseContractV1Schema.parse({
      ...basis,
      pairedCaseContractContentSha256: hashJson(basis),
    }),
  );
};

const trajectoryRuntimeIdentitiesSchema = z
  .object({
    schemaVersion: z.literal(1),
    classifierId: z.literal(M7_PATROL_TRAJECTORY_CLASSIFIER_ID_V1),
    classifierFreezeRecordSha256: Sha256DigestV1Schema,
    classifierImplementationSha256: Sha256DigestV1Schema,
    classifierConfigSha256: Sha256DigestV1Schema,
    caseSpecId: trajectoryCaseIdSchema,
    caseSpecSha256: Sha256DigestV1Schema,
  })
  .strict();
export type M7R3TrajectoryRuntimeIdentitiesV1 = z.infer<
  typeof trajectoryRuntimeIdentitiesSchema
>;

const createTrajectoryRuntimeIdentities = (
  contract: M7R3PairedCaseContractV1,
): M7R3TrajectoryRuntimeIdentitiesV1 =>
  trajectoryRuntimeIdentitiesSchema.parse({
    schemaVersion: 1,
    classifierId: contract.trajectoryCaseSpec.classifierId,
    classifierFreezeRecordSha256:
      contract.commonRuntimeMaterials.trajectoryClassifierFreezeRecordSha256,
    classifierImplementationSha256:
      contract.trajectoryCaseSpec.classifierImplementationSha256,
    classifierConfigSha256: contract.trajectoryCaseSpec.classifierConfigSha256,
    caseSpecId: contract.trajectoryCaseSpec.caseId,
    caseSpecSha256: contract.trajectoryCaseSpec.caseSpecSha256,
  });

export const M7R3RuntimeSurfaceBindingV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sensorFreezeRecordSha256: Sha256DigestV1Schema,
    pristineAdapterRevisionId: opaqueIdSchema,
    pristineAdapterRevisionSha256: Sha256DigestV1Schema,
    pristineAdapterPackageSha256: Sha256DigestV1Schema,
    pristineAdapterConformanceReceiptSha256: Sha256DigestV1Schema,
    admittedGameToolSetSha256: Sha256DigestV1Schema,
    runtimeResourceMap: M7RuntimeResourceMapV1Schema,
    runtimeResourceAppendixSha256: Sha256DigestV1Schema,
    trajectory: trajectoryRuntimeIdentitiesSchema,
  })
  .strict();
export type M7R3RuntimeSurfaceBindingV1 = z.infer<
  typeof M7R3RuntimeSurfaceBindingV1Schema
>;

/** Agent-facing appendix: generic runtime IDs only, with no classifier hint. */
export const createM7R3NeutralRuntimeResourceAppendixV1 = (
  resourceMap: M7RuntimeResourceMapV1,
): string => createM7NeutralRuntimeResourceAppendixV1(resourceMap);

const pairedInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-paired-agent-input"),
    campaignId: campaignIdSchema,
    caseCampaignAdmissionRecordSha256: Sha256DigestV1Schema,
    caseContract: M7R3PairedCaseContractV1Schema,
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
    thinkingLevel: thinkingLevelSchema,
    agentBudget: M7PairedAgentBudgetV1Schema,
    codingTools: z.array(M7CodingToolSurfaceEntryV1Schema).min(1).max(512),
    pristineAdapterRevision: ProjectAdapterRevisionV1Schema,
    hostAdmittedGameToolNames: z.array(toolNameSchema).min(1).max(512),
    runtimeResourceMap: M7RuntimeResourceMapV1Schema,
    runtimeIsolation: M7AgentArmIsolationV1Schema,
    codeOnlyIsolation: M7AgentArmIsolationV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const contract = value.caseContract;
    const expectedAgent = contract.agentConfiguration;
    if (
      value.provider !== expectedAgent.provider ||
      value.model !== expectedAgent.model ||
      value.thinkingLevel !== expectedAgent.thinkingLevel ||
      hashJson(value.agentBudget) !== expectedAgent.agentBudgetSha256 ||
      hashJson(value.codingTools) !== expectedAgent.codingToolSetSha256
    ) {
      addIssue(
        context,
        ["caseContract", "agentConfiguration"],
        "paired Agent configuration crossed the frozen R3 portfolio",
      );
    }
    if (
      value.runtimeIsolation.arm !== "runtime_enabled" ||
      value.codeOnlyIsolation.arm !== "code_only"
    ) {
      addIssue(
        context,
        ["runtimeIsolation", "arm"],
        "R3 arm isolations must retain their declared arms",
      );
    }
    if (value.runtimeResourceMap.taskId !== value.runtimeIsolation.taskId) {
      addIssue(
        context,
        ["runtimeResourceMap", "taskId"],
        "runtime resource map must belong to the runtime-enabled Task",
      );
    }
    for (const [field, isolation] of [
      ["runtimeIsolation", value.runtimeIsolation],
      ["codeOnlyIsolation", value.codeOnlyIsolation],
    ] as const) {
      if (
        isolation.workspaceBaselineSelectedTreeSha256 !==
        contract.mutatedBaselineSelectedTreeSha256
      ) {
        addIssue(
          context,
          [field, "workspaceBaselineSelectedTreeSha256"],
          "both R3 workspaces must begin at the admitted mutant tree",
        );
      }
    }
    if (
      value.runtimeIsolation.sandboxProfileSha256 !==
        value.codeOnlyIsolation.sandboxProfileSha256 ||
      value.runtimeIsolation.sandboxProfileSha256 !==
        expectedAgent.sandboxPolicySha256
    ) {
      addIssue(
        context,
        ["codeOnlyIsolation", "sandboxProfileSha256"],
        "both arms must use the frozen common sandbox policy",
      );
    }
    const runtimeInstances = [
      value.runtimeIsolation.workspaceInstanceSha256,
      value.runtimeIsolation.sessionInstanceSha256,
      value.runtimeIsolation.cacheInstanceSha256,
      value.runtimeIsolation.sandboxInstanceSha256,
    ];
    const codeOnlyInstances = [
      value.codeOnlyIsolation.workspaceInstanceSha256,
      value.codeOnlyIsolation.sessionInstanceSha256,
      value.codeOnlyIsolation.cacheInstanceSha256,
      value.codeOnlyIsolation.sandboxInstanceSha256,
    ];
    runtimeInstances.forEach((identity, index) => {
      if (identity === codeOnlyInstances[index]) {
        addIssue(
          context,
          ["codeOnlyIsolation"],
          "R3 workspace, Session, cache, and sandbox instances must be isolated",
        );
      }
    });
    const codingNames = value.codingTools.map((tool) => tool.name);
    if (new Set(codingNames).size !== codingNames.length) {
      addIssue(context, ["codingTools"], "coding tool names must be unique");
    }
    if (
      new Set(value.hostAdmittedGameToolNames).size !==
      value.hostAdmittedGameToolNames.length
    ) {
      addIssue(
        context,
        ["hostAdmittedGameToolNames"],
        "Host-admitted game tool names must be unique",
      );
    }
    if (
      value.hostAdmittedGameToolNames.some((name) => codingNames.includes(name))
    ) {
      addIssue(
        context,
        ["hostAdmittedGameToolNames"],
        "coding and game tool names must not overlap",
      );
    }
  });

export type M7R3PairedAgentInputV1 = z.infer<typeof pairedInputSchema>;
export const M7R3PairedAgentInputV1Schema = pairedInputSchema;

const surfaceProofBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-paired-agent-surface-equality-proof"),
    campaignId: campaignIdSchema,
    portfolioId: portfolioIdSchema,
    caseId: portfolioCaseIdSchema,
    caseCampaignAdmissionRecordSha256: Sha256DigestV1Schema,
    pairedCaseContractContentSha256: Sha256DigestV1Schema,
    promptUtf8Sha256: Sha256DigestV1Schema,
    promptCanonicalJsonSha256: Sha256DigestV1Schema,
    pairedPublicTaskContractSha256: Sha256DigestV1Schema,
    runtimeArmPublicTaskSpecSha256: Sha256DigestV1Schema,
    codeOnlyArmPublicTaskSpecSha256: Sha256DigestV1Schema,
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
    thinkingLevel: thinkingLevelSchema,
    agentBudgetSha256: Sha256DigestV1Schema,
    baselineSelectedTreeSha256: Sha256DigestV1Schema,
    commonEnvironmentInstructionsSha256: Sha256DigestV1Schema,
    hostModelRuntimeConfigSha256: Sha256DigestV1Schema,
    codingToolSetSha256: Sha256DigestV1Schema,
    sandboxProfileSha256: Sha256DigestV1Schema,
    runtimeResourceAppendixSha256: Sha256DigestV1Schema,
    codeOnlyResourceAppendixSha256: Sha256DigestV1Schema,
    runtimeGameToolSetSha256: Sha256DigestV1Schema,
    codeOnlyGameToolSetSha256: Sha256DigestV1Schema,
    runtimeTrajectoryIdentitiesSha256: Sha256DigestV1Schema,
    codeOnlyTrajectoryIdentitiesSha256: Sha256DigestV1Schema,
    declaredTreatmentDifference: z.literal("chronorift_runtime_surface"),
  })
  .strict();

export const M7R3PairedToolSurfaceEqualityProofV1Schema =
  surfaceProofBasisSchema
    .extend({ proofContentSha256: Sha256DigestV1Schema })
    .strict()
    .superRefine((value, context) => {
      if (value.codeOnlyResourceAppendixSha256 !== hashJson(null)) {
        addIssue(
          context,
          ["codeOnlyResourceAppendixSha256"],
          "code-only arm must have no runtime appendix",
        );
      }
      if (value.codeOnlyGameToolSetSha256 !== hashJson([])) {
        addIssue(
          context,
          ["codeOnlyGameToolSetSha256"],
          "code-only arm must have the canonical empty game-tool set",
        );
      }
      if (value.codeOnlyTrajectoryIdentitiesSha256 !== hashJson(null)) {
        addIssue(
          context,
          ["codeOnlyTrajectoryIdentitiesSha256"],
          "code-only arm must have no trajectory identities",
        );
      }
      const { proofContentSha256, ...basis } = value;
      if (proofContentSha256 !== hashJson(basis)) {
        addIssue(
          context,
          ["proofContentSha256"],
          "R3 surface-equality proof hash does not match",
        );
      }
    });
export type M7R3PairedToolSurfaceEqualityProofV1 = z.infer<
  typeof M7R3PairedToolSurfaceEqualityProofV1Schema
>;

const attemptBindingBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-paired-agent-attempt-binding"),
    campaignId: campaignIdSchema,
    portfolioId: portfolioIdSchema,
    caseId: portfolioCaseIdSchema,
    caseCampaignAdmissionRecordSha256: Sha256DigestV1Schema,
    pairedCaseContractContentSha256: Sha256DigestV1Schema,
    arm: armSchema,
    attemptOrdinal: z.literal(1),
    userTurnsMaximum: z.literal(1),
    promptUtf8Sha256: Sha256DigestV1Schema,
    promptCanonicalJsonSha256: Sha256DigestV1Schema,
    publicTaskSpecSha256: Sha256DigestV1Schema,
    pairedPublicTaskContractSha256: Sha256DigestV1Schema,
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
    thinkingLevel: thinkingLevelSchema,
    agentBudgetSha256: Sha256DigestV1Schema,
    baselineSelectedTreeSha256: Sha256DigestV1Schema,
    commonEnvironmentInstructionsSha256: Sha256DigestV1Schema,
    hostModelRuntimeConfigSha256: Sha256DigestV1Schema,
    codingToolSetSha256: Sha256DigestV1Schema,
    sandboxProfileSha256: Sha256DigestV1Schema,
    isolation: M7AgentArmIsolationV1Schema,
    surfaceEqualityProofSha256: Sha256DigestV1Schema,
    runtimeSurface: M7R3RuntimeSurfaceBindingV1Schema.nullable(),
  })
  .strict();

export const M7R3PairedAgentAttemptBindingV1Schema = attemptBindingBasisSchema
  .extend({ bindingContentSha256: Sha256DigestV1Schema })
  .strict()
  .superRefine((value, context) => {
    if (value.arm !== value.isolation.arm) {
      addIssue(
        context,
        ["isolation", "arm"],
        "R3 attempt binding crossed its arm isolation",
      );
    }
    if (
      value.baselineSelectedTreeSha256 !==
      value.isolation.workspaceBaselineSelectedTreeSha256
    ) {
      addIssue(
        context,
        ["isolation", "workspaceBaselineSelectedTreeSha256"],
        "R3 attempt binding crossed its admitted mutant baseline",
      );
    }
    if ((value.arm === "runtime_enabled") !== (value.runtimeSurface !== null)) {
      addIssue(
        context,
        ["runtimeSurface"],
        "only the runtime-enabled R3 attempt may bind a runtime surface",
      );
    }
    const { bindingContentSha256, ...basis } = value;
    if (bindingContentSha256 !== hashJson(basis)) {
      addIssue(
        context,
        ["bindingContentSha256"],
        "R3 attempt-binding hash does not match",
      );
    }
  });
export type M7R3PairedAgentAttemptBindingV1 = z.infer<
  typeof M7R3PairedAgentAttemptBindingV1Schema
>;

const gameToolCatalog = new Map(
  PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1.map((definition) => [
    definition.name,
    definition,
  ]),
);

const admittedGameToolSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: toolNameSchema,
    capability: z.string().min(1).max(256),
    availabilityModule: opaqueIdSchema.nullable(),
    adapterModuleStatus: z
      .enum([
        "implemented",
        "unsupported",
        "unavailable_by_policy",
        "unavailable_by_environment",
        "degraded",
      ])
      .nullable(),
    adapterProtocolVersion: z.string().min(1).max(256).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const definition = gameToolCatalog.get(
      value.name as M6AdmittedGameToolV1["name"],
    );
    if (
      definition === undefined ||
      value.capability !== definition.capability ||
      value.availabilityModule !== definition.availabilityModule
    ) {
      addIssue(
        context,
        ["name"],
        "admitted game tool does not match the protocol catalog",
      );
    }
    if (
      (value.availabilityModule === null) !==
      (value.adapterModuleStatus === null)
    ) {
      addIssue(
        context,
        ["adapterModuleStatus"],
        "Host tools have no Adapter status; Adapter tools require one",
      );
    }
  })
  .transform((value) => value as M6AdmittedGameToolV1);

const runtimeAccessSchema = z
  .object({
    schemaVersion: z.literal(1),
    sensorFreezeRecordSha256: Sha256DigestV1Schema,
    pristineAdapterRevisionId: opaqueIdSchema,
    pristineAdapterRevisionSha256: Sha256DigestV1Schema,
    pristineAdapterPackageSha256: Sha256DigestV1Schema,
    pristineAdapterConformanceReceiptSha256: Sha256DigestV1Schema,
    runtimeResourceMap: M7RuntimeResourceMapV1Schema,
    runtimeResourceAppendixSha256: Sha256DigestV1Schema,
    trajectory: trajectoryRuntimeIdentitiesSchema,
    gameTools: z.array(admittedGameToolSchema).min(1).max(512),
  })
  .strict();

const armRequestBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-paired-agent-arm-request"),
    campaignId: campaignIdSchema,
    portfolioId: portfolioIdSchema,
    caseId: portfolioCaseIdSchema,
    caseCampaignAdmissionRecordSha256: Sha256DigestV1Schema,
    pairedCaseContractContentSha256: Sha256DigestV1Schema,
    attemptOrdinal: z.literal(1),
    userTurnsMaximum: z.literal(1),
    prompt: z.string().min(1).max(16_384),
    promptIdentity: M7R3NaturalUserPromptV1Schema,
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
    thinkingLevel: thinkingLevelSchema,
    agentBudget: M7PairedAgentBudgetV1Schema,
    baselineSelectedTreeSha256: Sha256DigestV1Schema,
    commonEnvironmentInstructionsSha256: Sha256DigestV1Schema,
    hostModelRuntimeConfigSha256: Sha256DigestV1Schema,
    codingTools: z.array(M7CodingToolSurfaceEntryV1Schema).min(1).max(512),
    isolation: M7AgentArmIsolationV1Schema,
    attemptBinding: M7R3PairedAgentAttemptBindingV1Schema,
  })
  .strict();

const runtimeArmRequestSchema = armRequestBasisSchema
  .extend({
    arm: z.literal("runtime_enabled"),
    runtimeAccess: runtimeAccessSchema,
    gameTools: z.array(admittedGameToolSchema).min(1).max(512),
  })
  .strict();

const codeOnlyArmRequestSchema = armRequestBasisSchema
  .extend({
    arm: z.literal("code_only"),
    runtimeAccess: z.null(),
    gameTools: z.tuple([]),
  })
  .strict();

export const M7R3PairedAgentArmRequestV1Schema = z
  .discriminatedUnion("arm", [
    runtimeArmRequestSchema,
    codeOnlyArmRequestSchema,
  ])
  .superRefine((value, context) => {
    const binding = value.attemptBinding;
    if (
      value.prompt !== value.promptIdentity.text ||
      hashBytes(Buffer.from(value.prompt, "utf8")) !==
        binding.promptUtf8Sha256 ||
      hashJson(value.prompt) !== binding.promptCanonicalJsonSha256 ||
      value.campaignId !== binding.campaignId ||
      value.portfolioId !== binding.portfolioId ||
      value.caseId !== binding.caseId ||
      value.caseCampaignAdmissionRecordSha256 !==
        binding.caseCampaignAdmissionRecordSha256 ||
      value.pairedCaseContractContentSha256 !==
        binding.pairedCaseContractContentSha256 ||
      value.arm !== binding.arm ||
      value.arm !== value.isolation.arm ||
      value.provider !== binding.provider ||
      value.model !== binding.model ||
      value.thinkingLevel !== binding.thinkingLevel ||
      hashJson(value.agentBudget) !== binding.agentBudgetSha256 ||
      value.baselineSelectedTreeSha256 !== binding.baselineSelectedTreeSha256 ||
      value.commonEnvironmentInstructionsSha256 !==
        binding.commonEnvironmentInstructionsSha256 ||
      value.hostModelRuntimeConfigSha256 !==
        binding.hostModelRuntimeConfigSha256 ||
      hashJson(value.codingTools) !== binding.codingToolSetSha256 ||
      canonicalJson(value.isolation) !== canonicalJson(binding.isolation)
    ) {
      addIssue(
        context,
        ["attemptBinding"],
        "R3 arm request crossed its exact frozen attempt binding",
      );
    }
    if (value.arm === "runtime_enabled") {
      const surface = binding.runtimeSurface;
      if (
        surface === null ||
        value.runtimeAccess.sensorFreezeRecordSha256 !==
          surface.sensorFreezeRecordSha256 ||
        value.runtimeAccess.pristineAdapterRevisionId !==
          surface.pristineAdapterRevisionId ||
        value.runtimeAccess.pristineAdapterRevisionSha256 !==
          surface.pristineAdapterRevisionSha256 ||
        value.runtimeAccess.pristineAdapterPackageSha256 !==
          surface.pristineAdapterPackageSha256 ||
        value.runtimeAccess.pristineAdapterConformanceReceiptSha256 !==
          surface.pristineAdapterConformanceReceiptSha256 ||
        canonicalJson(value.runtimeAccess.runtimeResourceMap) !==
          canonicalJson(surface.runtimeResourceMap) ||
        value.runtimeAccess.runtimeResourceAppendixSha256 !==
          surface.runtimeResourceAppendixSha256 ||
        canonicalJson(value.runtimeAccess.trajectory) !==
          canonicalJson(surface.trajectory) ||
        hashJson(value.gameTools) !== surface.admittedGameToolSetSha256 ||
        hashJson(value.runtimeAccess.gameTools) !== hashJson(value.gameTools)
      ) {
        addIssue(
          context,
          ["runtimeAccess"],
          "runtime request crossed its frozen Adapter/game/trajectory surface",
        );
      }
    }
  });
export type M7R3PairedAgentArmRequestV1 = z.infer<
  typeof M7R3PairedAgentArmRequestV1Schema
>;

const candidatePatchSchema = z
  .object({
    schemaVersion: z.literal(1),
    patch: ExternalHiddenFixPatchReferenceV1Schema,
    patchIdentity: ExternalHiddenFixPatchIdentityV1Schema,
    admissible: z.boolean(),
    roundTripVerified: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.patch.rawSha256 !== value.patchIdentity.patchSha256 ||
      value.patch.byteLength !== value.patchIdentity.byteLength
    ) {
      addIssue(
        context,
        ["patch"],
        "candidate patch reference does not match its identity",
      );
    }
  });

const armResultBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-paired-agent-arm-result"),
    campaignId: campaignIdSchema,
    portfolioId: portfolioIdSchema,
    caseId: portfolioCaseIdSchema,
    caseCampaignAdmissionRecordSha256: Sha256DigestV1Schema,
    pairedCaseContractContentSha256: Sha256DigestV1Schema,
    attemptOrdinal: z.literal(1),
    userTurnCount: z.literal(1),
    status: z.enum(["completed", "provider_failure", "timed_out", "aborted"]),
    realizedProvider: z.string().min(1).max(256),
    realizedModel: z.string().min(1).max(256),
    realizedThinkingLevel: thinkingLevelSchema,
    activeToolNames: z.array(toolNameSchema).min(1).max(1_024),
    hostHttpTransportObservation: piHostHttpTransportObservationSchema
      .nullable()
      .optional(),
    attemptBindingContentSha256: Sha256DigestV1Schema,
    agentDeliveryTraceRecordSha256: Sha256DigestV1Schema,
    candidatePatch: candidatePatchSchema.nullable(),
    sourceObservations: z
      .array(ExternalHiddenFixHostSourceObservationV1Schema)
      .max(1_000),
  })
  .strict();

const runtimeArmResultBasisSchema = armResultBasisSchema
  .extend({
    arm: z.literal("runtime_enabled"),
    executions: z
      .array(ExternalHiddenFixPublicExecutionEvidenceV1Schema)
      .max(1_000),
    agentVisibleGameToolExchanges: z
      .array(M7AgentVisibleGameToolExchangeHashV1Schema)
      .max(100_000),
    trajectorySummaries: z
      .array(M7R3PatrolTrajectoryExecutionSummaryV1Schema)
      .max(1_000),
    runtimeEvidenceReceiptSha256: Sha256DigestV1Schema.nullable(),
  })
  .strict();

const codeOnlyArmResultBasisSchema = armResultBasisSchema
  .extend({
    arm: z.literal("code_only"),
    executions: z.tuple([]),
    agentVisibleGameToolExchanges: z.tuple([]),
    trajectorySummaries: z.tuple([]),
    runtimeEvidenceReceiptSha256: z.null(),
  })
  .strict();

const armResultUnionSchema = z
  .discriminatedUnion("arm", [
    runtimeArmResultBasisSchema,
    codeOnlyArmResultBasisSchema,
  ])
  .superRefine((value, context) => {
    if (new Set(value.activeToolNames).size !== value.activeToolNames.length) {
      addIssue(
        context,
        ["activeToolNames"],
        "active R3 Agent tool names must be unique",
      );
    }
    if (value.status !== "completed" && value.candidatePatch !== null) {
      addIssue(
        context,
        ["candidatePatch"],
        "an incomplete Agent loop cannot publish a candidate patch",
      );
    }
    if (value.arm === "runtime_enabled") {
      const hasRuntimeEvidence =
        value.executions.length > 0 ||
        value.agentVisibleGameToolExchanges.length > 0 ||
        value.trajectorySummaries.length > 0;
      if (hasRuntimeEvidence && value.runtimeEvidenceReceiptSha256 === null) {
        addIssue(
          context,
          ["runtimeEvidenceReceiptSha256"],
          "retained runtime evidence requires its Host receipt",
        );
      }
      const executionIds = new Set(
        value.executions.map((item) => item.executionId),
      );
      const summaryIds = new Set<string>();
      value.trajectorySummaries.forEach((summary, index) => {
        const execution = value.executions.find(
          (item) => item.executionId === summary.lineage.executionId,
        );
        if (
          execution === undefined ||
          execution.buildId !== summary.lineage.buildId ||
          execution.sourceSha256 !== summary.lineage.sourceSha256 ||
          execution.startedAt !== summary.startedAt ||
          execution.endedAt !== summary.endedAt ||
          execution.sealed !== summary.sealed ||
          execution.coverageComplete !== summary.coverage.complete ||
          execution.cleanupProven !== summary.cleanup.proven
        ) {
          addIssue(
            context,
            ["trajectorySummaries", index],
            "trajectory summary must match one retained public execution",
          );
        }
        if (summaryIds.has(summary.lineage.executionId)) {
          addIssue(
            context,
            ["trajectorySummaries", index],
            "an execution may have at most one R3 trajectory summary",
          );
        }
        summaryIds.add(summary.lineage.executionId);
      });
      if (executionIds.size !== value.executions.length) {
        addIssue(
          context,
          ["executions"],
          "runtime execution identities must be unique",
        );
      }
      value.agentVisibleGameToolExchanges.forEach((exchange, index) => {
        const previous = value.agentVisibleGameToolExchanges[index - 1];
        if (
          exchange.ordinal !== index + 1 ||
          (previous !== undefined &&
            exchange.hostToolReturnOrdinal <= previous.hostToolReturnOrdinal)
        ) {
          addIssue(
            context,
            ["agentVisibleGameToolExchanges", index],
            "runtime exchange ordinals must be contiguous and Host ordinals increasing",
          );
        }
      });
    }
  });

const runtimeArmResultSchema = runtimeArmResultBasisSchema
  .extend({ recordContentSha256: Sha256DigestV1Schema })
  .strict();
const codeOnlyArmResultSchema = codeOnlyArmResultBasisSchema
  .extend({ recordContentSha256: Sha256DigestV1Schema })
  .strict();

export const M7R3PairedAgentArmResultV1Schema = z
  .discriminatedUnion("arm", [runtimeArmResultSchema, codeOnlyArmResultSchema])
  .superRefine((value, context) => {
    const { recordContentSha256, ...basis } = value;
    const basisParsed = armResultUnionSchema.safeParse(basis);
    if (!basisParsed.success) {
      addIssue(context, [], "R3 arm-result basis is invalid");
      return;
    }
    if (recordContentSha256 !== hashJson(basis)) {
      addIssue(
        context,
        ["recordContentSha256"],
        "R3 arm-result content hash does not match",
      );
    }
  });
export type M7R3PairedAgentArmResultV1 = z.infer<
  typeof M7R3PairedAgentArmResultV1Schema
>;

export const createM7R3PairedAgentArmResultV1 = (
  input: z.input<typeof armResultUnionSchema>,
): M7R3PairedAgentArmResultV1 => {
  const basis = armResultUnionSchema.parse(input);
  return deepFreeze(
    M7R3PairedAgentArmResultV1Schema.parse({
      ...basis,
      recordContentSha256: hashJson(basis),
    }),
  );
};

const attemptEvidenceSidecarBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-agent-attempt-evidence-sidecar"),
    campaignId: campaignIdSchema,
    portfolioId: portfolioIdSchema,
    caseId: portfolioCaseIdSchema,
    caseCampaignAdmissionRecordSha256: Sha256DigestV1Schema,
    pairedCaseContractContentSha256: Sha256DigestV1Schema,
    arm: armSchema,
    attemptOrdinal: z.literal(1),
    attemptBindingContentSha256: Sha256DigestV1Schema,
    terminalStage: M7AgentAttemptEvidenceStageV1Schema,
    terminalCode: M7AgentAttemptEvidenceCodeV1Schema,
    piTurnStarted: z.boolean(),
    piResultObserved: z.boolean(),
    piStats: M7AgentAttemptPiStatsV1Schema.nullable(),
    agentVisibleGameToolExchanges: z
      .array(M7AgentVisibleGameToolExchangeHashV1Schema)
      .max(100_000),
    sourceObservations: z
      .array(ExternalHiddenFixHostSourceObservationV1Schema)
      .max(1_000),
    resultRecordContentSha256: Sha256DigestV1Schema.nullable(),
    agentDeliveryTraceRecordSha256: Sha256DigestV1Schema.nullable(),
    runtimeEvidenceReceiptSha256: Sha256DigestV1Schema.nullable(),
    trajectorySummarySha256s: z.array(Sha256DigestV1Schema).max(1_000),
    cleanup: M7AgentAttemptCleanupEvidenceV1Schema,
  })
  .strict();

export const M7R3AgentAttemptEvidenceSidecarV1Schema =
  attemptEvidenceSidecarBasisSchema
    .extend({ recordContentSha256: Sha256DigestV1Schema })
    .strict()
    .superRefine((value, context) => {
      if (value.piResultObserved && !value.piTurnStarted) {
        addIssue(
          context,
          ["piResultObserved"],
          "an observed Pi result requires an observed prompt submission",
        );
      }
      if (!value.piResultObserved && value.piStats !== null) {
        addIssue(
          context,
          ["piStats"],
          "Pi statistics require an observed Pi result",
        );
      }
      if (
        value.arm === "code_only" &&
        (value.agentVisibleGameToolExchanges.length !== 0 ||
          value.runtimeEvidenceReceiptSha256 !== null ||
          value.trajectorySummarySha256s.length !== 0)
      ) {
        addIssue(
          context,
          ["agentVisibleGameToolExchanges"],
          "code-only R3 sidecar cannot retain runtime evidence",
        );
      }
      if (
        value.resultRecordContentSha256 !== null &&
        value.agentDeliveryTraceRecordSha256 === null
      ) {
        addIssue(
          context,
          ["agentDeliveryTraceRecordSha256"],
          "a retained R3 result requires its full Pi delivery trace",
        );
      }
      value.agentVisibleGameToolExchanges.forEach((exchange, index) => {
        const previous = value.agentVisibleGameToolExchanges[index - 1];
        if (
          exchange.ordinal !== index + 1 ||
          (previous !== undefined &&
            exchange.hostToolReturnOrdinal <= previous.hostToolReturnOrdinal)
        ) {
          addIssue(
            context,
            ["agentVisibleGameToolExchanges", index],
            "R3 exchange ordinals must be contiguous and Host ordinals increasing",
          );
        }
      });
      if (
        (value.terminalStage === "sealed") !==
        (value.terminalCode === "completed")
      ) {
        addIssue(
          context,
          ["terminalCode"],
          "only a sealed R3 attempt may be completed",
        );
      }
      const { recordContentSha256, ...basis } = value;
      if (recordContentSha256 !== hashJson(basis)) {
        addIssue(
          context,
          ["recordContentSha256"],
          "R3 attempt-sidecar content hash does not match",
        );
      }
    });
export type M7R3AgentAttemptEvidenceSidecarV1 = z.infer<
  typeof M7R3AgentAttemptEvidenceSidecarV1Schema
>;

export const createM7R3AgentAttemptEvidenceSidecarV1 = (
  input: Omit<
    z.input<typeof attemptEvidenceSidecarBasisSchema>,
    "schemaVersion" | "recordKind" | "attemptOrdinal"
  >,
): M7R3AgentAttemptEvidenceSidecarV1 => {
  const basis = attemptEvidenceSidecarBasisSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-r3-agent-attempt-evidence-sidecar",
    attemptOrdinal: 1,
    ...input,
  });
  return deepFreeze(
    M7R3AgentAttemptEvidenceSidecarV1Schema.parse({
      ...basis,
      recordContentSha256: hashJson(basis),
    }),
  );
};

const attemptFailureReceiptBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-agent-attempt-failure"),
    campaignId: campaignIdSchema,
    portfolioId: portfolioIdSchema,
    caseId: portfolioCaseIdSchema,
    arm: armSchema,
    attemptBindingContentSha256: Sha256DigestV1Schema,
    attemptEvidenceRecordSha256: Sha256DigestV1Schema,
    piTurnStarted: z.boolean(),
    hostHttpTransportObservation: piHostHttpTransportObservationSchema
      .nullable()
      .optional(),
    lifecycle: z.array(piLifecycleEventSchema).max(8),
    primaryFailure: attemptFailureProjectionSchema.nullable(),
    cleanupFailures: z.array(attemptFailureProjectionSchema).max(4),
    sealFailure: attemptFailureProjectionSchema.nullable(),
  })
  .strict();

/**
 * Separate failure evidence referenced by the attempt. It carries no raw
 * Error, message, path, token, prompt, provider body, or session content.
 */
export const M7R3AgentAttemptFailureReceiptV1Schema =
  attemptFailureReceiptBasisSchema
    .extend({ recordContentSha256: Sha256DigestV1Schema })
    .strict()
    .superRefine((value, context) => {
      if (
        value.primaryFailure === null &&
        value.cleanupFailures.length === 0 &&
        value.sealFailure === null
      ) {
        addIssue(context, [], "attempt failure receipt requires a failure");
      }
      let priorOrdinal = 0;
      value.lifecycle.forEach((event, index) => {
        if (event.ordinal <= priorOrdinal) {
          addIssue(
            context,
            ["lifecycle", index],
            "Pi lifecycle milestones must be append-only and increasing",
          );
        }
        priorOrdinal = event.ordinal;
      });
      const promptSubmitted = value.lifecycle.some(
        (event) => event.stage === "prompt_submitted",
      );
      if (promptSubmitted && !value.piTurnStarted) {
        addIssue(
          context,
          ["piTurnStarted"],
          "a submitted prompt requires an observed Pi turn",
        );
      }
      const { recordContentSha256, ...basis } = value;
      if (recordContentSha256 !== hashJson(basis)) {
        addIssue(
          context,
          ["recordContentSha256"],
          "R3 attempt failure receipt content hash does not match",
        );
      }
    });
export type M7R3AgentAttemptFailureReceiptV1 = z.infer<
  typeof M7R3AgentAttemptFailureReceiptV1Schema
>;

export const createM7R3AgentAttemptFailureReceiptV1 = (
  input: Omit<
    z.input<typeof attemptFailureReceiptBasisSchema>,
    "schemaVersion" | "recordKind"
  >,
): M7R3AgentAttemptFailureReceiptV1 => {
  const basis = attemptFailureReceiptBasisSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-r3-agent-attempt-failure",
    ...input,
  });
  return deepFreeze(
    M7R3AgentAttemptFailureReceiptV1Schema.parse({
      ...basis,
      recordContentSha256: hashJson(basis),
    }),
  );
};

export interface M7R3PairedAgentAttemptEvidenceSealInputV1 {
  readonly schemaVersion: 1;
  readonly portfolioId: string;
  readonly caseId: string;
  readonly caseCampaignAdmissionRecordSha256: Sha256DigestV1;
  readonly pairedCaseContractContentSha256: Sha256DigestV1;
  readonly arm: M7R3PairedAgentArmV1;
  readonly campaignId: string;
  readonly attemptBindingContentSha256: Sha256DigestV1;
  readonly runnerFailureCode: "runner_threw" | "runner_result_invalid" | null;
  readonly cleanupFailureCode:
    "cleanup_threw" | "cleanup_result_invalid" | null;
  readonly cleanup: M7PairedAgentCleanupResultV1;
}

export interface M7R3PairedAgentPortV1 {
  /** Starts exactly one new Pi Session and sends `prompt` unchanged once. */
  runArm(request: M7R3PairedAgentArmRequestV1): Promise<unknown>;
  cleanupArm(input: {
    readonly schemaVersion: 1;
    readonly arm: M7R3PairedAgentArmV1;
    readonly attemptBindingContentSha256: Sha256DigestV1;
    readonly isolation: M7AgentArmIsolationV1;
  }): Promise<unknown>;
  sealAttemptEvidenceOnce?(
    input: M7R3PairedAgentAttemptEvidenceSealInputV1,
  ): Promise<unknown>;
}

export interface M7R3PairedAgentAttemptRecordV1 {
  readonly schemaVersion: 1;
  readonly recordKind: "m7-r3-paired-agent-attempt-record";
  readonly arm: M7R3PairedAgentArmV1;
  readonly binding: M7R3PairedAgentAttemptBindingV1;
  readonly result: M7R3PairedAgentArmResultV1 | null;
  readonly infrastructureFailureCode:
    "runner_threw" | "runner_result_invalid" | null;
  readonly cleanup: M7PairedAgentCleanupResultV1;
  readonly cleanupInfrastructureFailure: boolean;
  readonly attemptEvidence: M7R3AgentAttemptEvidenceSidecarV1;
  /** Absent on historical V1 records; new failed attempts always retain it. */
  readonly failureReceipt?: M7R3AgentAttemptFailureReceiptV1 | null;
}

const createSurfaceEqualityProof = (input: {
  readonly common: z.infer<typeof pairedInputSchema>;
  readonly gameTools: readonly M6AdmittedGameToolV1[];
  readonly trajectory: M7R3TrajectoryRuntimeIdentitiesV1;
  readonly runtimeResourceAppendix: string;
}): M7R3PairedToolSurfaceEqualityProofV1 => {
  const contract = input.common.caseContract;
  const basis = surfaceProofBasisSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-r3-paired-agent-surface-equality-proof",
    campaignId: input.common.campaignId,
    portfolioId: contract.portfolioId,
    caseId: contract.caseId,
    caseCampaignAdmissionRecordSha256:
      input.common.caseCampaignAdmissionRecordSha256,
    pairedCaseContractContentSha256: contract.pairedCaseContractContentSha256,
    promptUtf8Sha256: contract.naturalPrompt.utf8Sha256,
    promptCanonicalJsonSha256: contract.naturalPrompt.canonicalJsonSha256,
    pairedPublicTaskContractSha256: contract.pairedPublicTaskContractSha256,
    runtimeArmPublicTaskSpecSha256: contract.runtimeArmPublicTaskSpecSha256,
    codeOnlyArmPublicTaskSpecSha256: contract.codeOnlyArmPublicTaskSpecSha256,
    provider: input.common.provider,
    model: input.common.model,
    thinkingLevel: input.common.thinkingLevel,
    agentBudgetSha256: hashJson(input.common.agentBudget),
    baselineSelectedTreeSha256: contract.mutatedBaselineSelectedTreeSha256,
    commonEnvironmentInstructionsSha256:
      contract.commonRuntimeMaterials.commonEnvironmentInstructionsSha256,
    hostModelRuntimeConfigSha256:
      contract.commonRuntimeMaterials.hostModelRuntimeConfigSha256,
    codingToolSetSha256: hashJson(input.common.codingTools),
    sandboxProfileSha256: input.common.runtimeIsolation.sandboxProfileSha256,
    runtimeResourceAppendixSha256: hashJson(input.runtimeResourceAppendix),
    codeOnlyResourceAppendixSha256: hashJson(null),
    runtimeGameToolSetSha256: hashJson(input.gameTools),
    codeOnlyGameToolSetSha256: hashJson([]),
    runtimeTrajectoryIdentitiesSha256: hashJson(input.trajectory),
    codeOnlyTrajectoryIdentitiesSha256: hashJson(null),
    declaredTreatmentDifference: "chronorift_runtime_surface",
  });
  return M7R3PairedToolSurfaceEqualityProofV1Schema.parse({
    ...basis,
    proofContentSha256: hashJson(basis),
  });
};

const createAttemptBinding = (input: {
  readonly common: z.infer<typeof pairedInputSchema>;
  readonly arm: M7R3PairedAgentArmV1;
  readonly isolation: M7AgentArmIsolationV1;
  readonly proof: M7R3PairedToolSurfaceEqualityProofV1;
  readonly runtimeSurface: M7R3RuntimeSurfaceBindingV1 | null;
}): M7R3PairedAgentAttemptBindingV1 => {
  const contract = input.common.caseContract;
  const basis = attemptBindingBasisSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-r3-paired-agent-attempt-binding",
    campaignId: input.common.campaignId,
    portfolioId: contract.portfolioId,
    caseId: contract.caseId,
    caseCampaignAdmissionRecordSha256:
      input.common.caseCampaignAdmissionRecordSha256,
    pairedCaseContractContentSha256: contract.pairedCaseContractContentSha256,
    arm: input.arm,
    attemptOrdinal: 1,
    userTurnsMaximum: 1,
    promptUtf8Sha256: contract.naturalPrompt.utf8Sha256,
    promptCanonicalJsonSha256: contract.naturalPrompt.canonicalJsonSha256,
    publicTaskSpecSha256:
      input.arm === "runtime_enabled"
        ? contract.runtimeArmPublicTaskSpecSha256
        : contract.codeOnlyArmPublicTaskSpecSha256,
    pairedPublicTaskContractSha256: contract.pairedPublicTaskContractSha256,
    provider: input.common.provider,
    model: input.common.model,
    thinkingLevel: input.common.thinkingLevel,
    agentBudgetSha256: input.proof.agentBudgetSha256,
    baselineSelectedTreeSha256: contract.mutatedBaselineSelectedTreeSha256,
    commonEnvironmentInstructionsSha256:
      contract.commonRuntimeMaterials.commonEnvironmentInstructionsSha256,
    hostModelRuntimeConfigSha256:
      contract.commonRuntimeMaterials.hostModelRuntimeConfigSha256,
    codingToolSetSha256: input.proof.codingToolSetSha256,
    sandboxProfileSha256: input.proof.sandboxProfileSha256,
    isolation: input.isolation,
    surfaceEqualityProofSha256: input.proof.proofContentSha256,
    runtimeSurface: input.runtimeSurface,
  });
  return M7R3PairedAgentAttemptBindingV1Schema.parse({
    ...basis,
    bindingContentSha256: hashJson(basis),
  });
};

const createArmRequest = (input: {
  readonly common: z.infer<typeof pairedInputSchema>;
  readonly arm: M7R3PairedAgentArmV1;
  readonly isolation: M7AgentArmIsolationV1;
  readonly binding: M7R3PairedAgentAttemptBindingV1;
  readonly gameTools: readonly M6AdmittedGameToolV1[];
}): M7R3PairedAgentArmRequestV1 => {
  const contract = input.common.caseContract;
  const base = {
    schemaVersion: 1 as const,
    recordKind: "m7-r3-paired-agent-arm-request" as const,
    campaignId: input.common.campaignId,
    portfolioId: contract.portfolioId,
    caseId: contract.caseId,
    caseCampaignAdmissionRecordSha256:
      input.common.caseCampaignAdmissionRecordSha256,
    pairedCaseContractContentSha256: contract.pairedCaseContractContentSha256,
    attemptOrdinal: 1 as const,
    userTurnsMaximum: 1 as const,
    prompt: contract.naturalPrompt.text,
    promptIdentity: contract.naturalPrompt,
    provider: input.common.provider,
    model: input.common.model,
    thinkingLevel: input.common.thinkingLevel,
    agentBudget: input.common.agentBudget,
    baselineSelectedTreeSha256: contract.mutatedBaselineSelectedTreeSha256,
    commonEnvironmentInstructionsSha256:
      contract.commonRuntimeMaterials.commonEnvironmentInstructionsSha256,
    hostModelRuntimeConfigSha256:
      contract.commonRuntimeMaterials.hostModelRuntimeConfigSha256,
    codingTools: input.common.codingTools,
    isolation: input.isolation,
    attemptBinding: input.binding,
  };
  if (input.arm === "code_only") {
    return M7R3PairedAgentArmRequestV1Schema.parse({
      ...base,
      arm: "code_only",
      runtimeAccess: null,
      gameTools: [],
    });
  }
  const surface = input.binding.runtimeSurface;
  if (surface === null) {
    throw new TypeError("runtime-enabled R3 binding omitted its surface");
  }
  return M7R3PairedAgentArmRequestV1Schema.parse({
    ...base,
    arm: "runtime_enabled",
    runtimeAccess: {
      schemaVersion: 1,
      sensorFreezeRecordSha256: surface.sensorFreezeRecordSha256,
      pristineAdapterRevisionId: surface.pristineAdapterRevisionId,
      pristineAdapterRevisionSha256: surface.pristineAdapterRevisionSha256,
      pristineAdapterPackageSha256: surface.pristineAdapterPackageSha256,
      pristineAdapterConformanceReceiptSha256:
        surface.pristineAdapterConformanceReceiptSha256,
      runtimeResourceMap: surface.runtimeResourceMap,
      runtimeResourceAppendixSha256: surface.runtimeResourceAppendixSha256,
      trajectory: surface.trajectory,
      gameTools: input.gameTools,
    },
    gameTools: input.gameTools,
  });
};

export interface M7R3PairedAgentProtocolV1 {
  readonly schemaVersion: 1;
  readonly recordKind: "m7-r3-paired-agent-protocol";
  readonly caseCampaignAdmissionRecordSha256: Sha256DigestV1;
  readonly caseContract: M7R3PairedCaseContractV1;
  readonly surfaceEqualityProof: M7R3PairedToolSurfaceEqualityProofV1;
  readonly runtimeRequest: M7R3PairedAgentArmRequestV1 & {
    readonly arm: "runtime_enabled";
  };
  readonly codeOnlyRequest: M7R3PairedAgentArmRequestV1 & {
    readonly arm: "code_only";
  };
}

export const M7R3PairedAgentProtocolV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-paired-agent-protocol"),
    caseCampaignAdmissionRecordSha256: Sha256DigestV1Schema,
    caseContract: M7R3PairedCaseContractV1Schema,
    surfaceEqualityProof: M7R3PairedToolSurfaceEqualityProofV1Schema,
    runtimeRequest: M7R3PairedAgentArmRequestV1Schema,
    codeOnlyRequest: M7R3PairedAgentArmRequestV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const runtime = value.runtimeRequest;
    const codeOnly = value.codeOnlyRequest;
    const contract = value.caseContract;
    const proof = value.surfaceEqualityProof;
    const exactCommonSurface =
      runtime.prompt === contract.naturalPrompt.text &&
      codeOnly.prompt === contract.naturalPrompt.text &&
      canonicalJson(runtime.promptIdentity) ===
        canonicalJson(contract.naturalPrompt) &&
      canonicalJson(codeOnly.promptIdentity) ===
        canonicalJson(contract.naturalPrompt) &&
      runtime.provider === codeOnly.provider &&
      runtime.provider === contract.agentConfiguration.provider &&
      runtime.model === codeOnly.model &&
      runtime.model === contract.agentConfiguration.model &&
      runtime.thinkingLevel === codeOnly.thinkingLevel &&
      runtime.thinkingLevel === contract.agentConfiguration.thinkingLevel &&
      canonicalJson(runtime.agentBudget) ===
        canonicalJson(codeOnly.agentBudget) &&
      hashJson(runtime.agentBudget) ===
        contract.agentConfiguration.agentBudgetSha256 &&
      canonicalJson(runtime.codingTools) ===
        canonicalJson(codeOnly.codingTools) &&
      hashJson(runtime.codingTools) ===
        contract.agentConfiguration.codingToolSetSha256 &&
      runtime.baselineSelectedTreeSha256 ===
        codeOnly.baselineSelectedTreeSha256 &&
      runtime.baselineSelectedTreeSha256 ===
        contract.mutatedBaselineSelectedTreeSha256 &&
      runtime.commonEnvironmentInstructionsSha256 ===
        codeOnly.commonEnvironmentInstructionsSha256 &&
      runtime.commonEnvironmentInstructionsSha256 ===
        contract.commonRuntimeMaterials.commonEnvironmentInstructionsSha256 &&
      runtime.hostModelRuntimeConfigSha256 ===
        codeOnly.hostModelRuntimeConfigSha256 &&
      runtime.hostModelRuntimeConfigSha256 ===
        contract.commonRuntimeMaterials.hostModelRuntimeConfigSha256;
    const proofMatchesContract =
      proof.campaignId === runtime.campaignId &&
      proof.portfolioId === contract.portfolioId &&
      proof.caseId === contract.caseId &&
      proof.caseCampaignAdmissionRecordSha256 ===
        value.caseCampaignAdmissionRecordSha256 &&
      proof.pairedCaseContractContentSha256 ===
        contract.pairedCaseContractContentSha256 &&
      proof.promptUtf8Sha256 === contract.naturalPrompt.utf8Sha256 &&
      proof.promptCanonicalJsonSha256 ===
        contract.naturalPrompt.canonicalJsonSha256 &&
      proof.pairedPublicTaskContractSha256 ===
        contract.pairedPublicTaskContractSha256 &&
      proof.runtimeArmPublicTaskSpecSha256 ===
        contract.runtimeArmPublicTaskSpecSha256 &&
      proof.codeOnlyArmPublicTaskSpecSha256 ===
        contract.codeOnlyArmPublicTaskSpecSha256;
    if (
      runtime.arm !== "runtime_enabled" ||
      codeOnly.arm !== "code_only" ||
      !exactCommonSurface ||
      !proofMatchesContract ||
      runtime.caseCampaignAdmissionRecordSha256 !==
        value.caseCampaignAdmissionRecordSha256 ||
      codeOnly.caseCampaignAdmissionRecordSha256 !==
        value.caseCampaignAdmissionRecordSha256 ||
      runtime.pairedCaseContractContentSha256 !==
        value.caseContract.pairedCaseContractContentSha256 ||
      codeOnly.pairedCaseContractContentSha256 !==
        value.caseContract.pairedCaseContractContentSha256 ||
      runtime.attemptBinding.surfaceEqualityProofSha256 !==
        value.surfaceEqualityProof.proofContentSha256 ||
      codeOnly.attemptBinding.surfaceEqualityProofSha256 !==
        value.surfaceEqualityProof.proofContentSha256
    ) {
      addIssue(
        context,
        ["runtimeRequest"],
        "R3 protocol requests crossed the admitted case or paired proof",
      );
    }
  })
  .transform((value) => value as M7R3PairedAgentProtocolV1);

/** Freezes both R3 arm requests without starting either Agent. */
export const createM7R3PairedAgentProtocolV1 = (
  untrustedInput: M7R3PairedAgentInputV1,
): M7R3PairedAgentProtocolV1 => {
  const input = pairedInputSchema.parse(untrustedInput);
  const contract = M7R3PairedCaseContractV1Schema.parse(input.caseContract);
  const adapterRevision: ProjectAdapterRevisionV1 =
    ProjectAdapterRevisionV1Schema.parse(input.pristineAdapterRevision);
  if (
    hashJson(adapterRevision) !==
      contract.commonRuntimeMaterials.adapterRevisionSha256 ||
    adapterRevision.packageDigest !==
      contract.commonRuntimeMaterials.adapterPackageSha256
  ) {
    throw new TypeError("R3 Adapter revision crossed the admitted portfolio");
  }
  const gameTools = createM6AdmittedGameToolsV1({
    adapterRevision,
    hostAdmittedToolNames: input.hostAdmittedGameToolNames,
  });
  if (
    hashJson(gameTools) !==
    contract.commonRuntimeMaterials.validatedGameToolSetSha256
  ) {
    throw new TypeError("R3 game-tool set crossed the admitted portfolio");
  }
  const trajectory = createTrajectoryRuntimeIdentities(contract);
  const runtimeResourceAppendix = createM7R3NeutralRuntimeResourceAppendixV1(
    input.runtimeResourceMap,
  );
  const proof = createSurfaceEqualityProof({
    common: input,
    gameTools,
    trajectory,
    runtimeResourceAppendix,
  });
  const runtimeSurface = M7R3RuntimeSurfaceBindingV1Schema.parse({
    schemaVersion: 1,
    sensorFreezeRecordSha256:
      contract.commonRuntimeMaterials.authoritativeSensorFreezeRecordSha256,
    pristineAdapterRevisionId: adapterRevision.adapterRevisionId,
    pristineAdapterRevisionSha256:
      contract.commonRuntimeMaterials.adapterRevisionSha256,
    pristineAdapterPackageSha256: adapterRevision.packageDigest,
    pristineAdapterConformanceReceiptSha256:
      contract.commonRuntimeMaterials.pristineAdapterConformanceReceiptSha256,
    admittedGameToolSetSha256: proof.runtimeGameToolSetSha256,
    runtimeResourceMap: input.runtimeResourceMap,
    runtimeResourceAppendixSha256: proof.runtimeResourceAppendixSha256,
    trajectory,
  });
  const runtimeBinding = createAttemptBinding({
    common: input,
    arm: "runtime_enabled",
    isolation: input.runtimeIsolation,
    proof,
    runtimeSurface,
  });
  const codeOnlyBinding = createAttemptBinding({
    common: input,
    arm: "code_only",
    isolation: input.codeOnlyIsolation,
    proof,
    runtimeSurface: null,
  });
  const runtimeRequest = createArmRequest({
    common: input,
    arm: "runtime_enabled",
    isolation: input.runtimeIsolation,
    binding: runtimeBinding,
    gameTools,
  });
  const codeOnlyRequest = createArmRequest({
    common: input,
    arm: "code_only",
    isolation: input.codeOnlyIsolation,
    binding: codeOnlyBinding,
    gameTools: [],
  });
  if (
    runtimeRequest.arm !== "runtime_enabled" ||
    codeOnlyRequest.arm !== "code_only"
  ) {
    throw new TypeError("R3 paired protocol crossed its arm discriminants");
  }
  return deepFreeze(
    M7R3PairedAgentProtocolV1Schema.parse({
      schemaVersion: 1,
      recordKind: "m7-r3-paired-agent-protocol",
      caseCampaignAdmissionRecordSha256:
        input.caseCampaignAdmissionRecordSha256,
      caseContract: contract,
      surfaceEqualityProof: proof,
      runtimeRequest,
      codeOnlyRequest,
    }),
  );
};

const invalidCleanup = (
  arm: M7R3PairedAgentArmV1,
  binding: M7R3PairedAgentAttemptBindingV1,
): M7PairedAgentCleanupResultV1 => ({
  schemaVersion: 1,
  arm,
  attemptBindingContentSha256: binding.bindingContentSha256,
  proven: false,
  receiptSha256: null,
});

type M7R3AttemptFailureProjectionV1 = z.infer<
  typeof attemptFailureProjectionSchema
>;

const projectAttemptFailure = (
  error: unknown,
  stage: M7R3AttemptFailureProjectionV1["stage"],
): M7R3AttemptFailureProjectionV1 =>
  attemptFailureProjectionSchema.parse({
    ...projectVNextPiFailureV1(error, "input_validation"),
    stage,
  });

const collectRunnerFailure = (
  error: unknown,
  fallbackStage: M7R3AttemptFailureProjectionV1["stage"],
): {
  readonly lifecycle: readonly VNextPiLifecycleEventV1[];
  readonly hostHttpTransportObservation: VNextPiHostHttpTransportObservationV1 | null;
  readonly primaryFailure: M7R3AttemptFailureProjectionV1 | null;
  readonly cleanupFailures: readonly M7R3AttemptFailureProjectionV1[];
} => {
  if (error instanceof VNextPiTurnFailure) {
    return {
      lifecycle: error.receipt.lifecycle,
      hostHttpTransportObservation:
        error.receipt.hostHttpTransportObservation ?? null,
      primaryFailure:
        error.receipt.primaryFailure === null
          ? null
          : attemptFailureProjectionSchema.parse(error.receipt.primaryFailure),
      cleanupFailures: error.receipt.cleanupFailures.map((failure) =>
        attemptFailureProjectionSchema.parse(failure),
      ),
    };
  }
  if (error instanceof AggregateError && error.errors.length > 0) {
    const [primary, ...cleanup] = error.errors as unknown[];
    const nested = collectRunnerFailure(primary, fallbackStage);
    return {
      lifecycle: nested.lifecycle,
      hostHttpTransportObservation: nested.hostHttpTransportObservation,
      primaryFailure: nested.primaryFailure,
      cleanupFailures: [
        ...nested.cleanupFailures,
        ...cleanup.map((failure) =>
          projectAttemptFailure(failure, "arm_cleanup"),
        ),
      ].slice(0, 4),
    };
  }
  return {
    lifecycle: [],
    hostHttpTransportObservation: null,
    primaryFailure: projectAttemptFailure(error, fallbackStage),
    cleanupFailures: [],
  };
};

const failureStageFromAttempt = (
  stage: M7AgentAttemptEvidenceStageV1,
): M7R3AttemptFailureProjectionV1["stage"] => {
  if (stage === "pi_turn") return "agent_turn";
  if (stage === "runtime_close" || stage === "cleanup") {
    return "arm_cleanup";
  }
  if (stage === "arm_result_validation") return "arm_result_validation";
  if (stage === "attempt_evidence_seal") return "attempt_evidence_seal";
  return "arm_run";
};

const piTurnStartedFromFailure = (error: unknown): boolean => {
  if (error instanceof VNextPiTurnFailure) {
    return error.receipt.lifecycle.some(
      (event) => event.stage === "prompt_submitted",
    );
  }
  if (error instanceof AggregateError) {
    return error.errors.some((entry) => piTurnStartedFromFailure(entry));
  }
  return false;
};

const fallbackAttemptEvidence = (input: {
  readonly request: M7R3PairedAgentArmRequestV1;
  readonly result: M7R3PairedAgentArmResultV1 | null;
  readonly runnerPiTurnStarted: boolean;
  readonly runnerFailureCode: "runner_threw" | "runner_result_invalid" | null;
  readonly cleanupFailureCode:
    "cleanup_threw" | "cleanup_result_invalid" | null;
  readonly cleanup: M7PairedAgentCleanupResultV1;
  readonly sealFailureCode?: "operation_threw" | "result_invalid";
}): M7R3AgentAttemptEvidenceSidecarV1 => {
  const terminal = input.sealFailureCode
    ? {
        stage: "attempt_evidence_seal" as const,
        code: input.sealFailureCode,
      }
    : input.runnerFailureCode === "runner_threw"
      ? { stage: "pi_turn" as const, code: "operation_threw" as const }
      : input.runnerFailureCode === "runner_result_invalid"
        ? {
            stage: "arm_result_validation" as const,
            code: "result_invalid" as const,
          }
        : input.cleanupFailureCode === "cleanup_threw"
          ? { stage: "cleanup" as const, code: "operation_threw" as const }
          : input.cleanupFailureCode === "cleanup_result_invalid"
            ? { stage: "cleanup" as const, code: "result_invalid" as const }
            : !input.cleanup.proven
              ? {
                  stage: "cleanup" as const,
                  code: "cleanup_not_proven" as const,
                }
              : { stage: "sealed" as const, code: "completed" as const };
  const runtimeResult =
    input.result?.arm === "runtime_enabled" ? input.result : null;
  const runtimeCloseRequired = input.request.arm === "runtime_enabled";
  return createM7R3AgentAttemptEvidenceSidecarV1({
    campaignId: input.request.campaignId,
    portfolioId: input.request.portfolioId,
    caseId: input.request.caseId,
    caseCampaignAdmissionRecordSha256:
      input.request.caseCampaignAdmissionRecordSha256,
    pairedCaseContractContentSha256:
      input.request.pairedCaseContractContentSha256,
    arm: input.request.arm,
    attemptBindingContentSha256:
      input.request.attemptBinding.bindingContentSha256,
    terminalStage: terminal.stage,
    terminalCode: terminal.code,
    piTurnStarted: input.result !== null || input.runnerPiTurnStarted,
    piResultObserved: input.result !== null,
    piStats: null,
    agentVisibleGameToolExchanges:
      runtimeResult?.agentVisibleGameToolExchanges ?? [],
    sourceObservations: input.result?.sourceObservations ?? [],
    resultRecordContentSha256: input.result?.recordContentSha256 ?? null,
    agentDeliveryTraceRecordSha256:
      input.result?.agentDeliveryTraceRecordSha256 ?? null,
    runtimeEvidenceReceiptSha256:
      runtimeResult?.runtimeEvidenceReceiptSha256 ?? null,
    trajectorySummarySha256s:
      runtimeResult?.trajectorySummaries.map(
        (summary) => summary.summarySha256,
      ) ?? [],
    cleanup: {
      schemaVersion: 1,
      runtimeCloseRequired,
      runtimeCloseAttempted: runtimeCloseRequired && input.cleanup.proven,
      runtimeCloseCompleted: !runtimeCloseRequired || input.cleanup.proven,
      sandboxCleanupAttempted: true,
      sandboxCleanupReceiptObserved: false,
      processGroupTerminated: null,
      cgroupPopulated: null,
      termSent: null,
      killSent: null,
      scopeRemoved: null,
      storageReconciliationObserved: false,
      storageReconciled: null,
      cleanupResultValid: input.cleanupFailureCode === null,
      cleanupProven: input.cleanupFailureCode === null && input.cleanup.proven,
      cleanupReceiptSha256:
        input.cleanupFailureCode === null ? input.cleanup.receiptSha256 : null,
      cleanupInfrastructureFailure: input.cleanupFailureCode !== null,
    },
  });
};

const attemptEvidenceMatchesDisposition = (input: {
  readonly evidence: M7R3AgentAttemptEvidenceSidecarV1;
  readonly request: M7R3PairedAgentArmRequestV1;
  readonly result: M7R3PairedAgentArmResultV1 | null;
  readonly runnerFailureCode: "runner_threw" | "runner_result_invalid" | null;
  readonly cleanupFailureCode:
    "cleanup_threw" | "cleanup_result_invalid" | null;
  readonly cleanup: M7PairedAgentCleanupResultV1;
}): boolean => {
  const { evidence } = input;
  if (
    evidence.campaignId !== input.request.campaignId ||
    evidence.portfolioId !== input.request.portfolioId ||
    evidence.caseId !== input.request.caseId ||
    evidence.caseCampaignAdmissionRecordSha256 !==
      input.request.caseCampaignAdmissionRecordSha256 ||
    evidence.pairedCaseContractContentSha256 !==
      input.request.pairedCaseContractContentSha256 ||
    evidence.arm !== input.request.arm ||
    evidence.attemptBindingContentSha256 !==
      input.request.attemptBinding.bindingContentSha256 ||
    evidence.resultRecordContentSha256 !==
      (input.result?.recordContentSha256 ?? null) ||
    (input.result !== null &&
      evidence.agentDeliveryTraceRecordSha256 !==
        input.result.agentDeliveryTraceRecordSha256) ||
    evidence.cleanup.cleanupResultValid !==
      (input.cleanupFailureCode === null) ||
    evidence.cleanup.cleanupInfrastructureFailure !==
      (input.cleanupFailureCode !== null) ||
    evidence.cleanup.cleanupProven !==
      (input.cleanupFailureCode === null && input.cleanup.proven) ||
    evidence.cleanup.cleanupReceiptSha256 !==
      (input.cleanupFailureCode === null ? input.cleanup.receiptSha256 : null)
  ) {
    return false;
  }
  if (input.request.arm === "code_only") {
    if (
      evidence.agentVisibleGameToolExchanges.length !== 0 ||
      evidence.runtimeEvidenceReceiptSha256 !== null ||
      evidence.trajectorySummarySha256s.length !== 0
    ) {
      return false;
    }
  } else if (input.result?.arm === "runtime_enabled") {
    if (
      evidence.runtimeEvidenceReceiptSha256 !==
        input.result.runtimeEvidenceReceiptSha256 ||
      canonicalJson(evidence.agentVisibleGameToolExchanges) !==
        canonicalJson(input.result.agentVisibleGameToolExchanges) ||
      canonicalJson(evidence.trajectorySummarySha256s) !==
        canonicalJson(
          input.result.trajectorySummaries.map(
            (summary) => summary.summarySha256,
          ),
        )
    ) {
      return false;
    }
  }
  if (input.runnerFailureCode === "runner_threw") {
    return (
      evidence.terminalStage !== "sealed" &&
      evidence.terminalCode === "operation_threw"
    );
  }
  if (input.runnerFailureCode === "runner_result_invalid") {
    return (
      evidence.terminalStage === "arm_result_validation" &&
      evidence.terminalCode === "result_invalid"
    );
  }
  if (input.cleanupFailureCode === "cleanup_threw") {
    return (
      evidence.terminalStage === "cleanup" &&
      evidence.terminalCode === "operation_threw"
    );
  }
  if (input.cleanupFailureCode === "cleanup_result_invalid") {
    return (
      evidence.terminalStage === "cleanup" &&
      evidence.terminalCode === "result_invalid"
    );
  }
  if (!input.cleanup.proven) {
    return (
      evidence.terminalStage === "cleanup" &&
      evidence.terminalCode === "cleanup_not_proven"
    );
  }
  return (
    evidence.terminalStage === "sealed" && evidence.terminalCode === "completed"
  );
};

/** Runs one R3 arm once and always crosses the cleanup barrier exactly once. */
export const runM7R3PairedAgentArmOnceV1 = async (input: {
  readonly request: M7R3PairedAgentArmRequestV1;
  readonly port: M7R3PairedAgentPortV1;
}): Promise<M7R3PairedAgentAttemptRecordV1> => {
  const request = M7R3PairedAgentArmRequestV1Schema.parse(input.request);
  let result: M7R3PairedAgentArmResultV1 | null = null;
  let infrastructureFailureCode:
    "runner_threw" | "runner_result_invalid" | null = null;
  let runnerError: unknown;
  try {
    let untrustedResult: unknown;
    try {
      untrustedResult = await input.port.runArm(request);
    } catch (error) {
      runnerError = error;
      infrastructureFailureCode = "runner_threw";
    }
    if (infrastructureFailureCode === null) {
      const parsed =
        M7R3PairedAgentArmResultV1Schema.safeParse(untrustedResult);
      if (!parsed.success) {
        runnerError = new TypeError("R3 arm result failed schema validation");
        infrastructureFailureCode = "runner_result_invalid";
      } else {
        result = parsed.data;
        const expectedToolNames = [
          ...request.codingTools.map((tool) => tool.name),
          ...request.gameTools.map((tool) => tool.name),
        ];
        const trajectoryMismatch =
          result.arm === "runtime_enabled" &&
          request.arm === "runtime_enabled" &&
          result.trajectorySummaries.some(
            (summary) =>
              summary.classifierImplementationSha256 !==
                request.runtimeAccess.trajectory
                  .classifierImplementationSha256 ||
              summary.classification.classifierConfig.configSha256 !==
                request.runtimeAccess.trajectory.classifierConfigSha256 ||
              summary.classification.classifierId !==
                request.runtimeAccess.trajectory.classifierId,
          );
        if (
          result.arm !== request.arm ||
          result.campaignId !== request.campaignId ||
          result.portfolioId !== request.portfolioId ||
          result.caseId !== request.caseId ||
          result.caseCampaignAdmissionRecordSha256 !==
            request.caseCampaignAdmissionRecordSha256 ||
          result.pairedCaseContractContentSha256 !==
            request.pairedCaseContractContentSha256 ||
          result.attemptBindingContentSha256 !==
            request.attemptBinding.bindingContentSha256 ||
          result.realizedProvider !== request.provider ||
          result.realizedModel !== request.model ||
          result.realizedThinkingLevel !== request.thinkingLevel ||
          !sameSet(result.activeToolNames, expectedToolNames) ||
          trajectoryMismatch ||
          (result.candidatePatch !== null &&
            result.candidatePatch.patchIdentity.baselineSelectedTreeSha256 !==
              request.baselineSelectedTreeSha256)
        ) {
          result = null;
          runnerError = new TypeError("R3 arm result crossed its binding");
          infrastructureFailureCode = "runner_result_invalid";
        }
      }
    }
  } catch (error) {
    result = null;
    runnerError ??= error;
    infrastructureFailureCode = "runner_result_invalid";
  }

  let cleanup = invalidCleanup(request.arm, request.attemptBinding);
  let cleanupInfrastructureFailure = false;
  let cleanupFailureCode: "cleanup_threw" | "cleanup_result_invalid" | null =
    null;
  let cleanupError: unknown;
  try {
    const parsed = M7PairedAgentCleanupResultV1Schema.safeParse(
      await input.port.cleanupArm({
        schemaVersion: 1,
        arm: request.arm,
        attemptBindingContentSha256:
          request.attemptBinding.bindingContentSha256,
        isolation: request.isolation,
      }),
    );
    if (
      parsed.success &&
      parsed.data.arm === request.arm &&
      parsed.data.attemptBindingContentSha256 ===
        request.attemptBinding.bindingContentSha256
    ) {
      cleanup = parsed.data;
    } else {
      cleanupInfrastructureFailure = true;
      cleanupFailureCode = "cleanup_result_invalid";
      cleanupError = new TypeError("R3 cleanup result failed validation");
    }
  } catch (error) {
    cleanupInfrastructureFailure = true;
    cleanupFailureCode = "cleanup_threw";
    cleanupError = error;
  }

  let attemptEvidence: M7R3AgentAttemptEvidenceSidecarV1;
  let sealError: unknown;
  const runnerPiTurnStarted = piTurnStartedFromFailure(runnerError);
  if (input.port.sealAttemptEvidenceOnce === undefined) {
    attemptEvidence = fallbackAttemptEvidence({
      request,
      result,
      runnerPiTurnStarted,
      runnerFailureCode: infrastructureFailureCode,
      cleanupFailureCode,
      cleanup,
    });
  } else {
    try {
      const parsed = M7R3AgentAttemptEvidenceSidecarV1Schema.safeParse(
        await input.port.sealAttemptEvidenceOnce({
          schemaVersion: 1,
          portfolioId: request.portfolioId,
          caseId: request.caseId,
          caseCampaignAdmissionRecordSha256:
            request.caseCampaignAdmissionRecordSha256,
          pairedCaseContractContentSha256:
            request.pairedCaseContractContentSha256,
          arm: request.arm,
          campaignId: request.campaignId,
          attemptBindingContentSha256:
            request.attemptBinding.bindingContentSha256,
          runnerFailureCode: infrastructureFailureCode,
          cleanupFailureCode,
          cleanup,
        }),
      );
      if (
        !parsed.success ||
        !attemptEvidenceMatchesDisposition({
          evidence: parsed.data,
          request,
          result,
          runnerFailureCode: infrastructureFailureCode,
          cleanupFailureCode,
          cleanup,
        })
      ) {
        throw new TypeError("R3 attempt evidence crossed its binding");
      }
      attemptEvidence = parsed.data;
    } catch (error) {
      sealError = error;
      result = null;
      infrastructureFailureCode = "runner_result_invalid";
      attemptEvidence = fallbackAttemptEvidence({
        request,
        result,
        runnerPiTurnStarted,
        runnerFailureCode: infrastructureFailureCode,
        cleanupFailureCode,
        cleanup,
        sealFailureCode: "result_invalid",
      });
    }
  }

  const collectedRunner =
    runnerError === undefined
      ? {
          lifecycle: [],
          hostHttpTransportObservation: null,
          primaryFailure: null,
          cleanupFailures: [],
        }
      : collectRunnerFailure(
          runnerError,
          failureStageFromAttempt(attemptEvidence.terminalStage),
        );
  const collectedCleanup = [
    ...collectedRunner.cleanupFailures,
    ...(cleanupError === undefined
      ? []
      : [projectAttemptFailure(cleanupError, "arm_cleanup")]),
  ].slice(0, 4);
  const failureReceipt =
    collectedRunner.primaryFailure === null &&
    collectedCleanup.length === 0 &&
    sealError === undefined
      ? null
      : createM7R3AgentAttemptFailureReceiptV1({
          campaignId: request.campaignId,
          portfolioId: request.portfolioId,
          caseId: request.caseId,
          arm: request.arm,
          attemptBindingContentSha256:
            request.attemptBinding.bindingContentSha256,
          attemptEvidenceRecordSha256: attemptEvidence.recordContentSha256,
          piTurnStarted: attemptEvidence.piTurnStarted,
          hostHttpTransportObservation:
            collectedRunner.hostHttpTransportObservation,
          lifecycle: [...collectedRunner.lifecycle],
          primaryFailure: collectedRunner.primaryFailure,
          cleanupFailures: collectedCleanup,
          sealFailure:
            sealError === undefined
              ? null
              : projectAttemptFailure(sealError, "attempt_evidence_seal"),
        });

  return Object.freeze({
    schemaVersion: 1,
    recordKind: "m7-r3-paired-agent-attempt-record",
    arm: request.arm,
    binding: request.attemptBinding,
    result,
    infrastructureFailureCode,
    cleanup,
    cleanupInfrastructureFailure,
    attemptEvidence,
    failureReceipt,
  });
};
