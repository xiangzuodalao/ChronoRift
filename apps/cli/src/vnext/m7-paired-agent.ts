import {
  JsonValueSchema,
  ProjectAdapterRevisionV1Schema,
  Sha256DigestV1Schema,
  asSha256DigestV1,
  type ProjectAdapterRevisionV1,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson, contentHash } from "@chronorift/json-artifacts";
import { z } from "zod";

import {
  ExternalHiddenFixPatchIdentityV1Schema,
  ExternalHiddenFixPatchReferenceV1Schema,
} from "./external-hidden-fix.js";
import {
  ExternalHiddenFixHostSourceObservationV1Schema,
  ExternalHiddenFixPublicExecutionEvidenceV1Schema,
} from "./external-hidden-fix-workflow.js";
import { M7FrozenPatrolClassifierOutputV1Schema } from "./m7-patrol-sensor.js";
import { PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1 } from "@chronorift/agent-protocol";

import {
  createM6AdmittedGameToolsV1,
  type M6AdmittedGameToolV1,
} from "./m6-one-turn-agent.js";

/**
 * The two arms receive these exact bytes. Investigation order and validation
 * requirements are deliberately absent: whether an arm observed runtime state
 * is a Host-recorded experimental fact, not an instruction in the question.
 */
export const M7_NATURAL_USER_PROMPT_V1 =
  "Some enemies that are configured to patrol platforms walk off the edge and fall instead of turning around. Investigate and fix the behavior without changing enemies that are intentionally configured to fall from edges. Leave a reviewable candidate change.";

const campaignIdSchema = z.string().regex(/^m7-campaign:[a-f0-9]{24}$/u);
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
const thinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const armSchema = z.enum(["runtime_enabled", "code_only"]);

export type M7PairedAgentArmV1 = z.infer<typeof armSchema>;

const hashJson = (value: unknown): Sha256DigestV1 =>
  asSha256DigestV1(contentHash(JsonValueSchema.parse(value)));

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((entry) => right.includes(entry));

const runtimeResourceMapBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: opaqueIdSchema,
    baselineBuildId: opaqueIdSchema,
    baselineSourceId: opaqueIdSchema,
    launchTargetId: opaqueIdSchema,
  })
  .strict();

export const M7RuntimeResourceMapV1Schema = runtimeResourceMapBasisSchema
  .extend({ resourceMapSha256: Sha256DigestV1Schema })
  .strict()
  .superRefine((value, context) => {
    const { resourceMapSha256, ...basis } = value;
    if (resourceMapSha256 !== hashJson(basis)) {
      context.addIssue({
        code: "custom",
        path: ["resourceMapSha256"],
        message: "runtime resource-map content hash does not match",
      });
    }
  });
export type M7RuntimeResourceMapV1 = z.infer<
  typeof M7RuntimeResourceMapV1Schema
>;

export const createM7RuntimeResourceMapV1 = (
  input: z.input<typeof runtimeResourceMapBasisSchema>,
): M7RuntimeResourceMapV1 => {
  const basis = runtimeResourceMapBasisSchema.parse(input);
  return M7RuntimeResourceMapV1Schema.parse({
    ...basis,
    resourceMapSha256: hashJson(basis),
  });
};

/** Neutral identifier-only system appendix belonging to the runtime treatment. */
export const createM7NeutralRuntimeResourceAppendixV1 = (
  map: M7RuntimeResourceMapV1,
): string =>
  [
    "ChronoRift runtime resource map (identifiers only):",
    `- taskId: ${map.taskId}`,
    `- baselineBuildId: ${map.baselineBuildId}`,
    `- baselineSourceId: ${map.baselineSourceId}`,
    `- launchTargetId: ${map.launchTargetId}`,
  ].join("\n");

export const M7PairedAgentBudgetV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    attemptsMaximum: z.literal(1),
    userTurnsPerAttemptMaximum: z.literal(1),
    toolCallsMaximum: z.number().int().min(1).max(100_000),
    wallTimeMsMaximum: z.number().int().min(1).max(3_600_000),
    taskSandboxNetworkMode: z.literal("denied"),
    taskCredentialMountCountMaximum: z.literal(0),
  })
  .strict();
export type M7PairedAgentBudgetV1 = z.infer<typeof M7PairedAgentBudgetV1Schema>;

/** Frozen public campaign files omit the internal DTO's schemaVersion. */
export const M7PairedAgentBudgetFileV1Schema = M7PairedAgentBudgetV1Schema.omit(
  { schemaVersion: true },
);

export const normalizeM7PairedAgentBudgetV1 = (
  input: z.input<typeof M7PairedAgentBudgetFileV1Schema>,
): M7PairedAgentBudgetV1 =>
  M7PairedAgentBudgetV1Schema.parse({
    schemaVersion: 1,
    ...M7PairedAgentBudgetFileV1Schema.parse(input),
  });

export const M7CodingToolSurfaceEntryV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    family: z.literal("coding"),
    name: toolNameSchema,
    definitionSha256: Sha256DigestV1Schema,
  })
  .strict();
export type M7CodingToolSurfaceEntryV1 = z.infer<
  typeof M7CodingToolSurfaceEntryV1Schema
>;

const readableSurfaceSchema = z
  .object({
    chronoriftGameTools: z.boolean(),
    publicRuntimeRecordsThroughGameTools: z.boolean(),
    projectAdapterPackage: z.literal(false),
    rawGodotExecutable: z.literal(false),
    hiddenAssignmentStore: z.literal(false),
    hiddenMutationOrEvaluator: z.literal(false),
    otherArmPatchOrRecords: z.literal(false),
  })
  .strict();

export const M7AgentArmIsolationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    arm: armSchema,
    taskId: opaqueIdSchema,
    workspaceHandle: opaqueIdSchema,
    workspaceInstanceSha256: Sha256DigestV1Schema,
    sessionInstanceSha256: Sha256DigestV1Schema,
    cacheInstanceSha256: Sha256DigestV1Schema,
    sandboxInstanceSha256: Sha256DigestV1Schema,
    sandboxProfileSha256: Sha256DigestV1Schema,
    workspaceBaselineSelectedTreeSha256: Sha256DigestV1Schema,
    readableSurfaces: readableSurfaceSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const runtimeEnabled = value.arm === "runtime_enabled";
    if (
      value.readableSurfaces.chronoriftGameTools !== runtimeEnabled ||
      value.readableSurfaces.publicRuntimeRecordsThroughGameTools !==
        runtimeEnabled
    ) {
      context.addIssue({
        code: "custom",
        path: ["readableSurfaces"],
        message:
          "only the runtime-enabled arm may access game tools and their public runtime records",
      });
    }
  });
export type M7AgentArmIsolationV1 = z.infer<typeof M7AgentArmIsolationV1Schema>;

const pairedInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    campaignId: campaignIdSchema,
    publicTaskSpecSha256: Sha256DigestV1Schema,
    runtimeArmPublicTaskSpecSha256: Sha256DigestV1Schema,
    codeOnlyArmPublicTaskSpecSha256: Sha256DigestV1Schema,
    prompt: z.literal(M7_NATURAL_USER_PROMPT_V1),
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
    thinkingLevel: thinkingLevelSchema,
    agentBudget: M7PairedAgentBudgetV1Schema,
    baselineSelectedTreeSha256: Sha256DigestV1Schema,
    commonEnvironmentInstructionsSha256: Sha256DigestV1Schema,
    hostModelRuntimeConfigSha256: Sha256DigestV1Schema,
    codingTools: z.array(M7CodingToolSurfaceEntryV1Schema).min(1).max(512),
    sensorFreezeRecordSha256: Sha256DigestV1Schema,
    pristineAdapterRevision: ProjectAdapterRevisionV1Schema,
    hostAdmittedGameToolNames: z.array(toolNameSchema).min(1).max(512),
    runtimeResourceMap: M7RuntimeResourceMapV1Schema,
    runtimeIsolation: M7AgentArmIsolationV1Schema,
    codeOnlyIsolation: M7AgentArmIsolationV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.runtimeIsolation.arm !== "runtime_enabled") {
      context.addIssue({
        code: "custom",
        path: ["runtimeIsolation", "arm"],
        message: "runtime isolation must belong to the runtime-enabled arm",
      });
    }
    if (value.runtimeResourceMap.taskId !== value.runtimeIsolation.taskId) {
      context.addIssue({
        code: "custom",
        path: ["runtimeResourceMap", "taskId"],
        message: "runtime resource map must belong to the runtime arm Task",
      });
    }
    if (value.codeOnlyIsolation.arm !== "code_only") {
      context.addIssue({
        code: "custom",
        path: ["codeOnlyIsolation", "arm"],
        message: "code-only isolation must belong to the code-only arm",
      });
    }
    for (const [label, isolation] of [
      ["runtimeIsolation", value.runtimeIsolation],
      ["codeOnlyIsolation", value.codeOnlyIsolation],
    ] as const) {
      if (
        isolation.workspaceBaselineSelectedTreeSha256 !==
        value.baselineSelectedTreeSha256
      ) {
        context.addIssue({
          code: "custom",
          path: [label, "workspaceBaselineSelectedTreeSha256"],
          message: "both arm workspaces must begin at the frozen mutant tree",
        });
      }
    }
    if (
      value.runtimeIsolation.sandboxProfileSha256 !==
      value.codeOnlyIsolation.sandboxProfileSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["codeOnlyIsolation", "sandboxProfileSha256"],
        message: "both arms must use the same sandbox policy profile",
      });
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
    for (const [index, runtimeIdentity] of runtimeInstances.entries()) {
      if (runtimeIdentity === codeOnlyInstances[index]) {
        context.addIssue({
          code: "custom",
          path: ["codeOnlyIsolation"],
          message:
            "arm workspace, session, cache, and sandbox instances must be isolated",
        });
      }
    }
    const codingNames = value.codingTools.map((tool) => tool.name);
    if (new Set(codingNames).size !== codingNames.length) {
      context.addIssue({
        code: "custom",
        path: ["codingTools"],
        message: "coding tool names must be unique",
      });
    }
    if (
      new Set(value.hostAdmittedGameToolNames).size !==
      value.hostAdmittedGameToolNames.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["hostAdmittedGameToolNames"],
        message: "Host-admitted game tool names must be unique",
      });
    }
    for (const gameToolName of value.hostAdmittedGameToolNames) {
      if (codingNames.includes(gameToolName)) {
        context.addIssue({
          code: "custom",
          path: ["hostAdmittedGameToolNames"],
          message: "coding and game tool names must not overlap",
        });
      }
    }
  });

export type M7PairedAgentInputV1 = z.infer<typeof pairedInputSchema>;

const surfaceEqualityProofBaseSchema = z.object({
  schemaVersion: z.literal(1),
  campaignId: campaignIdSchema,
  promptSha256: Sha256DigestV1Schema,
  publicTaskSpecSha256: Sha256DigestV1Schema,
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
  declaredTreatmentDifference: z.literal("chronorift_runtime_surface"),
});

export const M7PairedToolSurfaceEqualityProofV1Schema =
  surfaceEqualityProofBaseSchema
    .extend({ proofContentSha256: Sha256DigestV1Schema })
    .strict()
    .superRefine((value, context) => {
      const { proofContentSha256, ...basis } = value;
      if (proofContentSha256 !== hashJson(basis)) {
        context.addIssue({
          code: "custom",
          path: ["proofContentSha256"],
          message: "paired tool-surface proof content hash does not match",
        });
      }
      if (value.codeOnlyGameToolSetSha256 !== hashJson([])) {
        context.addIssue({
          code: "custom",
          path: ["codeOnlyGameToolSetSha256"],
          message: "code-only game tool set must be the canonical empty set",
        });
      }
      if (value.codeOnlyResourceAppendixSha256 !== hashJson(null)) {
        context.addIssue({
          code: "custom",
          path: ["codeOnlyResourceAppendixSha256"],
          message: "code-only arm must have no runtime resource appendix",
        });
      }
    });
export type M7PairedToolSurfaceEqualityProofV1 = z.infer<
  typeof M7PairedToolSurfaceEqualityProofV1Schema
>;

const runtimeSurfaceBindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    sensorFreezeRecordSha256: Sha256DigestV1Schema,
    pristineAdapterRevisionId: opaqueIdSchema,
    pristineAdapterPackageSha256: Sha256DigestV1Schema,
    admittedGameToolSetSha256: Sha256DigestV1Schema,
    runtimeResourceMap: M7RuntimeResourceMapV1Schema,
    runtimeResourceAppendixSha256: Sha256DigestV1Schema,
  })
  .strict();

const attemptBindingBaseSchema = z.object({
  schemaVersion: z.literal(1),
  campaignId: campaignIdSchema,
  arm: armSchema,
  attemptOrdinal: z.literal(1),
  userTurnsMaximum: z.literal(1),
  promptSha256: Sha256DigestV1Schema,
  publicTaskSpecSha256: Sha256DigestV1Schema,
  pairedTaskSpecSha256: Sha256DigestV1Schema,
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
  runtimeSurface: runtimeSurfaceBindingSchema.nullable(),
});

export const M7PairedAgentAttemptBindingV1Schema = attemptBindingBaseSchema
  .extend({ bindingContentSha256: Sha256DigestV1Schema })
  .strict()
  .superRefine((value, context) => {
    if (value.arm !== value.isolation.arm) {
      context.addIssue({
        code: "custom",
        path: ["isolation", "arm"],
        message: "attempt binding crossed its arm isolation",
      });
    }
    if (
      value.baselineSelectedTreeSha256 !==
      value.isolation.workspaceBaselineSelectedTreeSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["isolation", "workspaceBaselineSelectedTreeSha256"],
        message: "attempt binding crossed its frozen workspace baseline",
      });
    }
    if ((value.arm === "runtime_enabled") !== (value.runtimeSurface !== null)) {
      context.addIssue({
        code: "custom",
        path: ["runtimeSurface"],
        message: "only the runtime-enabled attempt may bind a runtime surface",
      });
    }
    const { bindingContentSha256, ...basis } = value;
    if (bindingContentSha256 !== hashJson(basis)) {
      context.addIssue({
        code: "custom",
        path: ["bindingContentSha256"],
        message: "paired Agent attempt binding content hash does not match",
      });
    }
  });
export type M7PairedAgentAttemptBindingV1 = z.infer<
  typeof M7PairedAgentAttemptBindingV1Schema
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
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: "admitted game tool does not match the protocol catalog",
      });
    }
    if (
      (value.availabilityModule === null) !==
      (value.adapterModuleStatus === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["adapterModuleStatus"],
        message:
          "Host-level tools have no Adapter module status; Adapter-backed tools require one",
      });
    }
  })
  .transform((value) => value as M6AdmittedGameToolV1);

const runtimeAccessSchema = z
  .object({
    schemaVersion: z.literal(1),
    sensorFreezeRecordSha256: Sha256DigestV1Schema,
    pristineAdapterRevisionId: opaqueIdSchema,
    pristineAdapterPackageSha256: Sha256DigestV1Schema,
    runtimeResourceMap: M7RuntimeResourceMapV1Schema,
    runtimeResourceAppendixSha256: Sha256DigestV1Schema,
    gameTools: z.array(admittedGameToolSchema).min(1).max(512),
  })
  .strict();

const armRequestBaseSchema = z.object({
  schemaVersion: z.literal(1),
  campaignId: campaignIdSchema,
  attemptOrdinal: z.literal(1),
  userTurnsMaximum: z.literal(1),
  prompt: z.literal(M7_NATURAL_USER_PROMPT_V1),
  provider: z.string().min(1).max(256),
  model: z.string().min(1).max(256),
  thinkingLevel: thinkingLevelSchema,
  agentBudget: M7PairedAgentBudgetV1Schema,
  baselineSelectedTreeSha256: Sha256DigestV1Schema,
  commonEnvironmentInstructionsSha256: Sha256DigestV1Schema,
  hostModelRuntimeConfigSha256: Sha256DigestV1Schema,
  codingTools: z.array(M7CodingToolSurfaceEntryV1Schema).min(1).max(512),
  isolation: M7AgentArmIsolationV1Schema,
  attemptBinding: M7PairedAgentAttemptBindingV1Schema,
});

const runtimeArmRequestSchema = armRequestBaseSchema
  .extend({
    arm: z.literal("runtime_enabled"),
    runtimeAccess: runtimeAccessSchema,
    gameTools: z.array(admittedGameToolSchema).min(1).max(512),
  })
  .strict();

const codeOnlyArmRequestSchema = armRequestBaseSchema
  .extend({
    arm: z.literal("code_only"),
    runtimeAccess: z.null(),
    gameTools: z.tuple([]),
  })
  .strict();

export const M7PairedAgentArmRequestV1Schema = z
  .discriminatedUnion("arm", [
    runtimeArmRequestSchema,
    codeOnlyArmRequestSchema,
  ])
  .superRefine((value, context) => {
    const binding = value.attemptBinding;
    if (
      value.arm !== binding.arm ||
      value.arm !== value.isolation.arm ||
      value.campaignId !== binding.campaignId ||
      hashJson(value.prompt) !== binding.promptSha256 ||
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
      hashJson(value.isolation) !== hashJson(binding.isolation)
    ) {
      context.addIssue({
        code: "custom",
        path: ["attemptBinding"],
        message: "Agent arm request crossed its frozen attempt binding",
      });
    }
    if (value.arm === "runtime_enabled") {
      const runtimeSurface = binding.runtimeSurface;
      if (
        runtimeSurface === null ||
        value.runtimeAccess.sensorFreezeRecordSha256 !==
          runtimeSurface.sensorFreezeRecordSha256 ||
        value.runtimeAccess.pristineAdapterRevisionId !==
          runtimeSurface.pristineAdapterRevisionId ||
        value.runtimeAccess.pristineAdapterPackageSha256 !==
          runtimeSurface.pristineAdapterPackageSha256 ||
        canonicalJson(value.runtimeAccess.runtimeResourceMap) !==
          canonicalJson(runtimeSurface.runtimeResourceMap) ||
        value.runtimeAccess.runtimeResourceAppendixSha256 !==
          runtimeSurface.runtimeResourceAppendixSha256 ||
        hashJson(value.gameTools) !==
          runtimeSurface.admittedGameToolSetSha256 ||
        hashJson(value.runtimeAccess.gameTools) !== hashJson(value.gameTools)
      ) {
        context.addIssue({
          code: "custom",
          path: ["runtimeAccess"],
          message:
            "runtime-enabled request crossed its frozen Adapter/game-tool surface",
        });
      }
    }
  });
export type M7PairedAgentArmRequestV1 = z.infer<
  typeof M7PairedAgentArmRequestV1Schema
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
      context.addIssue({
        code: "custom",
        path: ["patch"],
        message: "candidate patch reference does not match its identity",
      });
    }
  });

const armResultBaseSchema = z.object({
  schemaVersion: z.literal(1),
  attemptOrdinal: z.literal(1),
  userTurnCount: z.literal(1),
  status: z.enum(["completed", "provider_failure", "timed_out", "aborted"]),
  realizedProvider: z.string().min(1).max(256),
  realizedModel: z.string().min(1).max(256),
  realizedThinkingLevel: thinkingLevelSchema,
  activeToolNames: z.array(toolNameSchema).min(1).max(1_024),
  attemptBindingContentSha256: Sha256DigestV1Schema,
  candidatePatch: candidatePatchSchema.nullable(),
});

export const M7RuntimeUseClassificationV1Schema = z.enum([
  "fell_without_reversing",
  "reversed_while_grounded",
  "mixed",
  "insufficient",
]);
export type M7RuntimeUseClassificationV1 = z.infer<
  typeof M7RuntimeUseClassificationV1Schema
>;

export const M7HostObservedSourceChangeBoundaryV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    hostToolReturnOrdinal: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    boundary: z.enum(["coding_tool_return", "game_build_freeze"]),
    sourceSha256: Sha256DigestV1Schema,
    buildId: opaqueIdSchema.nullable(),
    observedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.boundary === "game_build_freeze") !== (value.buildId !== null)) {
      context.addIssue({
        code: "custom",
        path: ["buildId"],
        message:
          "only a game Build-freeze source change carries its Build identity",
      });
    }
  });
export type M7HostObservedSourceChangeBoundaryV1 = z.infer<
  typeof M7HostObservedSourceChangeBoundaryV1Schema
>;

/**
 * Durable, typed projection of one runtime execution that the Agent actually
 * reached through a game-tool call. The complete generic classifier output is
 * retained; the category is only a deterministic summary of its witness set.
 */
export const M7RuntimeUseExecutionSummaryV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    executionId: opaqueIdSchema,
    buildId: opaqueIdSchema,
    sourceSha256: Sha256DigestV1Schema,
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    sealed: z.literal(true),
    coverageComplete: z.boolean(),
    historyLossObserved: z.boolean(),
    cleanupProven: z.boolean(),
    runtimeObservationReceiptSha256: Sha256DigestV1Schema,
    classifierImplementationSha256: Sha256DigestV1Schema,
    classifierInputSha256: Sha256DigestV1Schema,
    /** Null means runtime sealing was not itself returned by an Agent game call. */
    sealHostToolReturnOrdinal: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    /**
     * Return boundary at which the Agent had received all public patrol rows
     * needed for this classification. This, rather than execution sealing
     * time, is the authoritative pre-edit runtime-use ordering fact.
     */
    classificationHostToolReturnOrdinal: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    classification: M7RuntimeUseClassificationV1Schema,
    classificationOutput: M7FrozenPatrolClassifierOutputV1Schema,
    classificationOutputSha256: Sha256DigestV1Schema,
    firstHostObservedSourceChange:
      M7HostObservedSourceChangeBoundaryV1Schema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.endedAt) < Date.parse(value.startedAt)) {
      context.addIssue({
        code: "custom",
        path: ["endedAt"],
        message: "runtime-use execution cannot end before it starts",
      });
    }
    if (
      value.classificationOutputSha256 !== hashJson(value.classificationOutput)
    ) {
      context.addIssue({
        code: "custom",
        path: ["classificationOutputSha256"],
        message: "runtime-use classification output hash does not match",
      });
    }
    const expected =
      value.classificationOutput.classification === "insufficient_observation"
        ? "insufficient"
        : value.classificationOutput.classification;
    if (value.classification !== expected) {
      context.addIssue({
        code: "custom",
        path: ["classification"],
        message:
          "runtime-use category must derive from the complete classifier output",
      });
    }
    if (
      (value.classification === "insufficient") !==
      (value.classificationHostToolReturnOrdinal === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["classificationHostToolReturnOrdinal"],
        message:
          "a nonempty runtime classification must bind its Agent-visible delivery boundary",
      });
    }
    if (
      value.sealHostToolReturnOrdinal !== null &&
      value.firstHostObservedSourceChange !== null &&
      value.sourceSha256 === value.firstHostObservedSourceChange.sourceSha256 &&
      value.sealHostToolReturnOrdinal <
        value.firstHostObservedSourceChange.hostToolReturnOrdinal
    ) {
      context.addIssue({
        code: "custom",
        path: ["firstHostObservedSourceChange", "sourceSha256"],
        message:
          "the first source-change boundary cannot identify the pre-boundary execution source",
      });
    }
  });
export type M7RuntimeUseExecutionSummaryV1 = z.infer<
  typeof M7RuntimeUseExecutionSummaryV1Schema
>;

const runtimeArmResultSchema = armResultBaseSchema
  .extend({
    arm: z.literal("runtime_enabled"),
    sourceObservations: z
      .array(ExternalHiddenFixHostSourceObservationV1Schema)
      .max(1_000),
    executions: z
      .array(ExternalHiddenFixPublicExecutionEvidenceV1Schema)
      .max(1_000),
    runtimeUseSummaries: z
      .array(M7RuntimeUseExecutionSummaryV1Schema)
      .max(1_000),
    runtimeEvidenceReceiptSha256: Sha256DigestV1Schema.nullable(),
  })
  .strict();

const codeOnlyArmResultSchema = armResultBaseSchema
  .extend({
    arm: z.literal("code_only"),
    sourceObservations: z
      .array(ExternalHiddenFixHostSourceObservationV1Schema)
      .max(1_000),
    executions: z.tuple([]),
    runtimeUseSummaries: z.tuple([]),
    runtimeEvidenceReceiptSha256: z.null(),
  })
  .strict();

export const M7PairedAgentArmResultV1Schema = z
  .discriminatedUnion("arm", [runtimeArmResultSchema, codeOnlyArmResultSchema])
  .superRefine((value, context) => {
    if (new Set(value.activeToolNames).size !== value.activeToolNames.length) {
      context.addIssue({
        code: "custom",
        path: ["activeToolNames"],
        message: "active Agent tool names must be unique",
      });
    }
    if (value.status !== "completed" && value.candidatePatch !== null) {
      context.addIssue({
        code: "custom",
        path: ["candidatePatch"],
        message: "an incomplete Agent loop cannot publish a candidate patch",
      });
    }
    if (
      value.arm === "runtime_enabled" &&
      value.executions.length > 0 &&
      value.runtimeEvidenceReceiptSha256 === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["runtimeEvidenceReceiptSha256"],
        message:
          "runtime execution evidence requires its persisted Host record receipt",
      });
    }
    if (value.arm === "runtime_enabled") {
      if (value.executions.length !== value.runtimeUseSummaries.length) {
        context.addIssue({
          code: "custom",
          path: ["runtimeUseSummaries"],
          message:
            "each runtime execution requires exactly one typed runtime-use summary",
        });
      }
      for (const [index, execution] of value.executions.entries()) {
        const summary = value.runtimeUseSummaries[index];
        if (
          summary === undefined ||
          summary.executionId !== execution.executionId ||
          summary.buildId !== execution.buildId ||
          summary.sourceSha256 !== execution.sourceSha256 ||
          summary.startedAt !== execution.startedAt ||
          summary.endedAt !== execution.endedAt ||
          summary.sealed !== execution.sealed ||
          summary.coverageComplete !== execution.coverageComplete ||
          summary.cleanupProven !== execution.cleanupProven
        ) {
          context.addIssue({
            code: "custom",
            path: ["runtimeUseSummaries", index],
            message:
              "typed runtime-use summary must match its public execution lineage",
          });
        }
      }
    }
  });
export type M7PairedAgentArmResultV1 = z.infer<
  typeof M7PairedAgentArmResultV1Schema
>;

export const M7PairedAgentCleanupResultV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    arm: armSchema,
    attemptBindingContentSha256: Sha256DigestV1Schema,
    proven: z.boolean(),
    receiptSha256: Sha256DigestV1Schema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.proven && value.receiptSha256 === null) {
      context.addIssue({
        code: "custom",
        path: ["receiptSha256"],
        message: "proven arm cleanup requires a durable receipt",
      });
    }
  });
export type M7PairedAgentCleanupResultV1 = z.infer<
  typeof M7PairedAgentCleanupResultV1Schema
>;

export const M7AgentAttemptEvidenceStageV1Schema = z.enum([
  "pre_agent_sentinel",
  "baseline_source_observation",
  "pi_turn",
  "runtime_close",
  "pi_result_validation",
  "runtime_evidence_projection",
  "candidate_patch_handoff",
  "arm_result_validation",
  "cleanup",
  "attempt_evidence_seal",
  "sealed",
]);
export type M7AgentAttemptEvidenceStageV1 = z.infer<
  typeof M7AgentAttemptEvidenceStageV1Schema
>;

export const M7AgentAttemptEvidenceCodeV1Schema = z.enum([
  "completed",
  "operation_threw",
  "result_invalid",
  "cleanup_not_proven",
]);
export type M7AgentAttemptEvidenceCodeV1 = z.infer<
  typeof M7AgentAttemptEvidenceCodeV1Schema
>;

const nonnegativeSafeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

export const M7AgentAttemptPiStatsV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    eventsObserved: nonnegativeSafeIntegerSchema,
    userMessages: nonnegativeSafeIntegerSchema,
    assistantMessages: nonnegativeSafeIntegerSchema,
    toolCalls: nonnegativeSafeIntegerSchema,
    toolResults: nonnegativeSafeIntegerSchema,
    totalMessages: nonnegativeSafeIntegerSchema,
    inputTokens: nonnegativeSafeIntegerSchema,
    outputTokens: nonnegativeSafeIntegerSchema,
    cacheReadTokens: nonnegativeSafeIntegerSchema,
    cacheWriteTokens: nonnegativeSafeIntegerSchema,
    totalTokens: nonnegativeSafeIntegerSchema,
    cost: z.number().finite().nonnegative(),
  })
  .strict();
export type M7AgentAttemptPiStatsV1 = z.infer<
  typeof M7AgentAttemptPiStatsV1Schema
>;

const agentVisibleExchangeHashBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    ordinal: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    hostToolReturnOrdinal: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    toolName: toolNameSchema,
    inputSha256: Sha256DigestV1Schema,
    response: JsonValueSchema,
    responseSha256: Sha256DigestV1Schema,
  })
  .strict();

export const M7AgentVisibleGameToolExchangeHashV1Schema =
  agentVisibleExchangeHashBasisSchema
    .extend({ exchangeSha256: Sha256DigestV1Schema })
    .strict()
    .superRefine((value, context) => {
      const { exchangeSha256, ...basis } = value;
      if (value.responseSha256 !== hashJson(value.response)) {
        context.addIssue({
          code: "custom",
          path: ["responseSha256"],
          message: "Agent-visible game-tool response hash does not match",
        });
      }
      if (exchangeSha256 !== hashJson(basis)) {
        context.addIssue({
          code: "custom",
          path: ["exchangeSha256"],
          message: "Agent-visible game-tool exchange hash does not match",
        });
      }
    });
export type M7AgentVisibleGameToolExchangeHashV1 = z.infer<
  typeof M7AgentVisibleGameToolExchangeHashV1Schema
>;

/**
 * Retains the exact final ToolResult.details bytes-as-JSON the Agent received.
 * Inputs remain hash-only. Model prose, Session fields, and Host Error objects never enter this
 * projection; the response is already part of the admitted public game-tool
 * surface and is needed to independently recompute a runtime witness.
 */
export const createM7AgentVisibleGameToolExchangeHashV1 = (input: {
  readonly ordinal: number;
  readonly hostToolReturnOrdinal: number;
  readonly toolName: string;
  readonly input: unknown;
  readonly response: unknown;
}): M7AgentVisibleGameToolExchangeHashV1 => {
  const basis = agentVisibleExchangeHashBasisSchema.parse({
    schemaVersion: 1,
    ordinal: input.ordinal,
    hostToolReturnOrdinal: input.hostToolReturnOrdinal,
    toolName: input.toolName,
    inputSha256: hashJson(input.input),
    response: JsonValueSchema.parse(input.response),
    responseSha256: hashJson(input.response),
  });
  return M7AgentVisibleGameToolExchangeHashV1Schema.parse({
    ...basis,
    exchangeSha256: hashJson(basis),
  });
};

export const M7AgentAttemptCleanupEvidenceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    runtimeCloseRequired: z.boolean(),
    runtimeCloseAttempted: z.boolean(),
    runtimeCloseCompleted: z.boolean(),
    sandboxCleanupAttempted: z.boolean(),
    sandboxCleanupReceiptObserved: z.boolean(),
    processGroupTerminated: z.boolean().nullable(),
    cgroupPopulated: z.boolean().nullable(),
    termSent: z.boolean().nullable(),
    killSent: z.boolean().nullable(),
    scopeRemoved: z.boolean().nullable(),
    storageReconciliationObserved: z.boolean(),
    storageReconciled: z.boolean().nullable(),
    cleanupResultValid: z.boolean(),
    cleanupProven: z.boolean(),
    cleanupReceiptSha256: Sha256DigestV1Schema.nullable(),
    cleanupInfrastructureFailure: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.runtimeCloseCompleted &&
      value.runtimeCloseRequired &&
      !value.runtimeCloseAttempted
    ) {
      context.addIssue({
        code: "custom",
        path: ["runtimeCloseCompleted"],
        message: "required runtime close cannot complete without an attempt",
      });
    }
    const requiredSandboxFields = [
      value.processGroupTerminated,
      value.cgroupPopulated,
      value.termSent,
      value.killSent,
      value.scopeRemoved,
    ];
    if (
      value.sandboxCleanupReceiptObserved !==
      requiredSandboxFields.every((entry) => entry !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sandboxCleanupReceiptObserved"],
        message:
          "sandbox cleanup Boolean fields require exactly one observed receipt",
      });
    }
    if (
      value.storageReconciliationObserved !==
        (value.storageReconciled !== null) ||
      (value.storageReconciliationObserved &&
        !value.sandboxCleanupReceiptObserved)
    ) {
      context.addIssue({
        code: "custom",
        path: ["storageReconciliationObserved"],
        message:
          "storage reconciliation requires its explicit cleanup receipt field",
      });
    }
    if (
      (value.cleanupProven &&
        (!value.cleanupResultValid ||
          value.cleanupInfrastructureFailure ||
          value.cleanupReceiptSha256 === null)) ||
      ((!value.cleanupResultValid || value.cleanupInfrastructureFailure) &&
        value.cleanupReceiptSha256 !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["cleanupProven"],
        message:
          "cleanup proof must agree with the validated durable cleanup result",
      });
    }
  });
export type M7AgentAttemptCleanupEvidenceV1 = z.infer<
  typeof M7AgentAttemptCleanupEvidenceV1Schema
>;

const attemptEvidenceSidecarBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-agent-attempt-evidence-sidecar"),
    campaignId: campaignIdSchema,
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
    runtimeEvidenceReceiptSha256: Sha256DigestV1Schema.nullable(),
    cleanup: M7AgentAttemptCleanupEvidenceV1Schema,
  })
  .strict();

export const M7AgentAttemptEvidenceSidecarV1Schema =
  attemptEvidenceSidecarBasisSchema
    .extend({ recordContentSha256: Sha256DigestV1Schema })
    .strict()
    .superRefine((value, context) => {
      const { recordContentSha256, ...basis } = value;
      if (recordContentSha256 !== hashJson(basis)) {
        context.addIssue({
          code: "custom",
          path: ["recordContentSha256"],
          message: "Agent-attempt evidence sidecar hash does not match",
        });
      }
      if (!value.piResultObserved && value.piStats !== null) {
        context.addIssue({
          code: "custom",
          path: ["piStats"],
          message: "Pi statistics require an observed Pi result",
        });
      }
      if (
        value.arm === "code_only" &&
        (value.agentVisibleGameToolExchanges.length !== 0 ||
          value.runtimeEvidenceReceiptSha256 !== null)
      ) {
        context.addIssue({
          code: "custom",
          path: ["agentVisibleGameToolExchanges"],
          message: "code-only attempt cannot retain runtime exchanges",
        });
      }
      value.agentVisibleGameToolExchanges.forEach((exchange, index) => {
        const previous = value.agentVisibleGameToolExchanges[index - 1];
        if (
          exchange.ordinal !== index + 1 ||
          (previous !== undefined &&
            exchange.hostToolReturnOrdinal <= previous.hostToolReturnOrdinal)
        ) {
          context.addIssue({
            code: "custom",
            path: ["agentVisibleGameToolExchanges", index],
            message:
              "Agent-visible exchange ordinals must be contiguous and Host return ordinals increasing",
          });
        }
      });
      if (
        (value.terminalStage === "sealed") !==
        (value.terminalCode === "completed")
      ) {
        context.addIssue({
          code: "custom",
          path: ["terminalCode"],
          message: "only a sealed attempt may be completed",
        });
      }
    });
export type M7AgentAttemptEvidenceSidecarV1 = z.infer<
  typeof M7AgentAttemptEvidenceSidecarV1Schema
>;

export const createM7AgentAttemptEvidenceSidecarV1 = (
  input: Omit<
    z.input<typeof attemptEvidenceSidecarBasisSchema>,
    "schemaVersion" | "recordKind" | "attemptOrdinal"
  >,
): M7AgentAttemptEvidenceSidecarV1 => {
  const basis = attemptEvidenceSidecarBasisSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-agent-attempt-evidence-sidecar",
    attemptOrdinal: 1,
    ...input,
  });
  return M7AgentAttemptEvidenceSidecarV1Schema.parse({
    ...basis,
    recordContentSha256: hashJson(basis),
  });
};

export interface M7PairedAgentAttemptEvidenceSealInputV1 {
  readonly schemaVersion: 1;
  readonly arm: M7PairedAgentArmV1;
  readonly campaignId: string;
  readonly attemptBindingContentSha256: Sha256DigestV1;
  readonly runnerFailureCode: "runner_threw" | "runner_result_invalid" | null;
  readonly cleanupFailureCode:
    "cleanup_threw" | "cleanup_result_invalid" | null;
  readonly cleanup: M7PairedAgentCleanupResultV1;
}

export interface M7PairedAgentPortV1 {
  /**
   * Runs exactly one new Pi Session with exactly one user turn. Implementations
   * must pass `prompt` unchanged and must not append task-specific workflow,
   * reproduction, runtime-use, or verification instructions.
   */
  runArm(request: M7PairedAgentArmRequestV1): Promise<unknown>;
  cleanupArm(input: {
    readonly schemaVersion: 1;
    readonly arm: M7PairedAgentArmV1;
    readonly attemptBindingContentSha256: Sha256DigestV1;
    readonly isolation: M7AgentArmIsolationV1;
  }): Promise<unknown>;
  /**
   * Returns a strict allowlisted Host-only projection after cleanup. The
   * implementation may retain partial progress in memory, but must never put
   * Error objects, model prose, Session identifiers, paths, or secrets in the
   * sidecar.
   */
  sealAttemptEvidenceOnce?(
    input: M7PairedAgentAttemptEvidenceSealInputV1,
  ): Promise<unknown>;
}

export interface M7PairedAgentAttemptRecordV1 {
  readonly schemaVersion: 1;
  readonly arm: M7PairedAgentArmV1;
  readonly binding: M7PairedAgentAttemptBindingV1;
  readonly result: M7PairedAgentArmResultV1 | null;
  readonly infrastructureFailureCode:
    "runner_threw" | "runner_result_invalid" | null;
  readonly cleanup: M7PairedAgentCleanupResultV1;
  readonly cleanupInfrastructureFailure: boolean;
  readonly attemptEvidence: M7AgentAttemptEvidenceSidecarV1;
}

export interface M7PairedAgentRunResultV1 {
  readonly schemaVersion: 1;
  readonly status:
    | "both_arms_recorded"
    | "runtime_infrastructure_failure"
    | "runtime_cleanup_failed"
    | "code_only_infrastructure_failure"
    | "code_only_cleanup_failed";
  readonly surfaceEqualityProof: M7PairedToolSurfaceEqualityProofV1;
  readonly attemptedOrder: readonly M7PairedAgentArmV1[];
  readonly runtimeArm: M7PairedAgentAttemptRecordV1;
  readonly codeOnlyArm: M7PairedAgentAttemptRecordV1 | null;
}

const createSurfaceEqualityProof = (input: {
  readonly campaignId: string;
  readonly publicTaskSpecSha256: Sha256DigestV1;
  readonly runtimeArmPublicTaskSpecSha256: Sha256DigestV1;
  readonly codeOnlyArmPublicTaskSpecSha256: Sha256DigestV1;
  readonly prompt: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: z.infer<typeof thinkingLevelSchema>;
  readonly agentBudget: M7PairedAgentBudgetV1;
  readonly baselineSelectedTreeSha256: Sha256DigestV1;
  readonly commonEnvironmentInstructionsSha256: Sha256DigestV1;
  readonly hostModelRuntimeConfigSha256: Sha256DigestV1;
  readonly codingTools: readonly M7CodingToolSurfaceEntryV1[];
  readonly sandboxProfileSha256: Sha256DigestV1;
  readonly gameTools: readonly M6AdmittedGameToolV1[];
  readonly runtimeResourceMap: M7RuntimeResourceMapV1;
}): M7PairedToolSurfaceEqualityProofV1 => {
  const basis = {
    schemaVersion: 1 as const,
    campaignId: input.campaignId,
    promptSha256: hashJson(input.prompt),
    publicTaskSpecSha256: input.publicTaskSpecSha256,
    runtimeArmPublicTaskSpecSha256: input.runtimeArmPublicTaskSpecSha256,
    codeOnlyArmPublicTaskSpecSha256: input.codeOnlyArmPublicTaskSpecSha256,
    provider: input.provider,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    agentBudgetSha256: hashJson(input.agentBudget),
    baselineSelectedTreeSha256: input.baselineSelectedTreeSha256,
    commonEnvironmentInstructionsSha256:
      input.commonEnvironmentInstructionsSha256,
    hostModelRuntimeConfigSha256: input.hostModelRuntimeConfigSha256,
    codingToolSetSha256: hashJson(input.codingTools),
    sandboxProfileSha256: input.sandboxProfileSha256,
    runtimeResourceAppendixSha256: hashJson(
      createM7NeutralRuntimeResourceAppendixV1(input.runtimeResourceMap),
    ),
    codeOnlyResourceAppendixSha256: hashJson(null),
    runtimeGameToolSetSha256: hashJson(input.gameTools),
    codeOnlyGameToolSetSha256: hashJson([]),
    declaredTreatmentDifference: "chronorift_runtime_surface" as const,
  };
  return M7PairedToolSurfaceEqualityProofV1Schema.parse({
    ...basis,
    proofContentSha256: hashJson(basis),
  });
};

const createAttemptBinding = (input: {
  readonly common: z.infer<typeof pairedInputSchema>;
  readonly arm: M7PairedAgentArmV1;
  readonly isolation: M7AgentArmIsolationV1;
  readonly proof: M7PairedToolSurfaceEqualityProofV1;
  readonly runtimeSurface: z.infer<typeof runtimeSurfaceBindingSchema> | null;
}): M7PairedAgentAttemptBindingV1 => {
  const basis = {
    schemaVersion: 1 as const,
    campaignId: input.common.campaignId,
    arm: input.arm,
    attemptOrdinal: 1 as const,
    userTurnsMaximum: 1 as const,
    promptSha256: input.proof.promptSha256,
    publicTaskSpecSha256:
      input.arm === "runtime_enabled"
        ? input.common.runtimeArmPublicTaskSpecSha256
        : input.common.codeOnlyArmPublicTaskSpecSha256,
    pairedTaskSpecSha256: input.common.publicTaskSpecSha256,
    provider: input.common.provider,
    model: input.common.model,
    thinkingLevel: input.common.thinkingLevel,
    agentBudgetSha256: input.proof.agentBudgetSha256,
    baselineSelectedTreeSha256: input.common.baselineSelectedTreeSha256,
    commonEnvironmentInstructionsSha256:
      input.common.commonEnvironmentInstructionsSha256,
    hostModelRuntimeConfigSha256: input.common.hostModelRuntimeConfigSha256,
    codingToolSetSha256: input.proof.codingToolSetSha256,
    sandboxProfileSha256: input.proof.sandboxProfileSha256,
    isolation: input.isolation,
    surfaceEqualityProofSha256: input.proof.proofContentSha256,
    runtimeSurface: input.runtimeSurface,
  };
  return M7PairedAgentAttemptBindingV1Schema.parse({
    ...basis,
    bindingContentSha256: hashJson(basis),
  });
};

const createArmRequest = (input: {
  readonly common: z.infer<typeof pairedInputSchema>;
  readonly arm: M7PairedAgentArmV1;
  readonly isolation: M7AgentArmIsolationV1;
  readonly binding: M7PairedAgentAttemptBindingV1;
  readonly gameTools: readonly M6AdmittedGameToolV1[];
}): M7PairedAgentArmRequestV1 => {
  const base = {
    schemaVersion: 1 as const,
    campaignId: input.common.campaignId,
    attemptOrdinal: 1 as const,
    userTurnsMaximum: 1 as const,
    prompt: input.common.prompt,
    provider: input.common.provider,
    model: input.common.model,
    thinkingLevel: input.common.thinkingLevel,
    agentBudget: input.common.agentBudget,
    baselineSelectedTreeSha256: input.common.baselineSelectedTreeSha256,
    commonEnvironmentInstructionsSha256:
      input.common.commonEnvironmentInstructionsSha256,
    hostModelRuntimeConfigSha256: input.common.hostModelRuntimeConfigSha256,
    codingTools: input.common.codingTools,
    isolation: input.isolation,
    attemptBinding: input.binding,
  };
  if (input.arm === "code_only") {
    return M7PairedAgentArmRequestV1Schema.parse({
      ...base,
      arm: input.arm,
      runtimeAccess: null,
      gameTools: [],
    });
  }
  const runtimeSurface = input.binding.runtimeSurface;
  if (runtimeSurface === null) {
    throw new TypeError("runtime-enabled binding omitted its runtime surface");
  }
  return M7PairedAgentArmRequestV1Schema.parse({
    ...base,
    arm: input.arm,
    runtimeAccess: {
      schemaVersion: 1,
      sensorFreezeRecordSha256: runtimeSurface.sensorFreezeRecordSha256,
      pristineAdapterRevisionId: runtimeSurface.pristineAdapterRevisionId,
      pristineAdapterPackageSha256: runtimeSurface.pristineAdapterPackageSha256,
      runtimeResourceMap: runtimeSurface.runtimeResourceMap,
      runtimeResourceAppendixSha256:
        runtimeSurface.runtimeResourceAppendixSha256,
      gameTools: input.gameTools,
    },
    gameTools: input.gameTools,
  });
};

const invalidCleanup = (
  arm: M7PairedAgentArmV1,
  binding: M7PairedAgentAttemptBindingV1,
): M7PairedAgentCleanupResultV1 => ({
  schemaVersion: 1,
  arm,
  attemptBindingContentSha256: binding.bindingContentSha256,
  proven: false,
  receiptSha256: null,
});

const fallbackAttemptEvidence = (input: {
  readonly request: M7PairedAgentArmRequestV1;
  readonly result: M7PairedAgentArmResultV1 | null;
  readonly runnerFailureCode: "runner_threw" | "runner_result_invalid" | null;
  readonly cleanupFailureCode:
    "cleanup_threw" | "cleanup_result_invalid" | null;
  readonly cleanup: M7PairedAgentCleanupResultV1;
  readonly sealFailureCode?: "operation_threw" | "result_invalid";
}): M7AgentAttemptEvidenceSidecarV1 => {
  const terminal = input.sealFailureCode
    ? {
        stage: "attempt_evidence_seal" as const,
        code: input.sealFailureCode,
      }
    : input.runnerFailureCode === "runner_threw"
      ? {
          stage: "pi_turn" as const,
          code: "operation_threw" as const,
        }
      : input.runnerFailureCode === "runner_result_invalid"
        ? {
            stage: "arm_result_validation" as const,
            code: "result_invalid" as const,
          }
        : input.cleanupFailureCode === "cleanup_threw"
          ? {
              stage: "cleanup" as const,
              code: "operation_threw" as const,
            }
          : input.cleanupFailureCode === "cleanup_result_invalid"
            ? {
                stage: "cleanup" as const,
                code: "result_invalid" as const,
              }
            : !input.cleanup.proven
              ? {
                  stage: "cleanup" as const,
                  code: "cleanup_not_proven" as const,
                }
              : { stage: "sealed" as const, code: "completed" as const };
  const runtimeCloseRequired = input.request.arm === "runtime_enabled";
  return createM7AgentAttemptEvidenceSidecarV1({
    campaignId: input.request.campaignId,
    arm: input.request.arm,
    attemptBindingContentSha256:
      input.request.attemptBinding.bindingContentSha256,
    terminalStage: terminal.stage,
    terminalCode: terminal.code,
    piTurnStarted: input.result !== null || input.runnerFailureCode !== null,
    piResultObserved: input.result !== null,
    piStats: null,
    agentVisibleGameToolExchanges: [],
    sourceObservations: input.result?.sourceObservations ?? [],
    runtimeEvidenceReceiptSha256:
      input.result?.arm === "runtime_enabled"
        ? input.result.runtimeEvidenceReceiptSha256
        : null,
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
  readonly evidence: M7AgentAttemptEvidenceSidecarV1;
  readonly runnerFailureCode: "runner_threw" | "runner_result_invalid" | null;
  readonly cleanupFailureCode:
    "cleanup_threw" | "cleanup_result_invalid" | null;
  readonly cleanup: M7PairedAgentCleanupResultV1;
}): boolean => {
  const { evidence } = input;
  if (
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

export const runM7PairedAgentArmOnceV1 = async (input: {
  readonly request: M7PairedAgentArmRequestV1;
  readonly port: M7PairedAgentPortV1;
}): Promise<M7PairedAgentAttemptRecordV1> => {
  let result: M7PairedAgentArmResultV1 | null = null;
  let infrastructureFailureCode:
    "runner_threw" | "runner_result_invalid" | null = null;
  try {
    let untrustedResult: unknown;
    try {
      untrustedResult = await input.port.runArm(input.request);
    } catch {
      infrastructureFailureCode = "runner_threw";
    }
    if (infrastructureFailureCode === null) {
      const parsed = M7PairedAgentArmResultV1Schema.safeParse(untrustedResult);
      if (!parsed.success) {
        infrastructureFailureCode = "runner_result_invalid";
      } else {
        result = parsed.data;
        const expectedToolNames = [
          ...input.request.codingTools.map((tool) => tool.name),
          ...input.request.gameTools.map((tool) => tool.name),
        ];
        if (
          result.arm !== input.request.arm ||
          result.attemptBindingContentSha256 !==
            input.request.attemptBinding.bindingContentSha256 ||
          result.realizedProvider !== input.request.provider ||
          result.realizedModel !== input.request.model ||
          result.realizedThinkingLevel !== input.request.thinkingLevel ||
          !sameSet(result.activeToolNames, expectedToolNames) ||
          (result.candidatePatch !== null &&
            result.candidatePatch.patchIdentity.baselineSelectedTreeSha256 !==
              input.request.baselineSelectedTreeSha256)
        ) {
          result = null;
          infrastructureFailureCode = "runner_result_invalid";
        }
      }
    }
  } catch {
    result = null;
    infrastructureFailureCode = "runner_result_invalid";
  }
  let cleanup = invalidCleanup(input.request.arm, input.request.attemptBinding);
  let cleanupInfrastructureFailure = false;
  let cleanupFailureCode: "cleanup_threw" | "cleanup_result_invalid" | null =
    null;
  try {
    const parsed = M7PairedAgentCleanupResultV1Schema.safeParse(
      await input.port.cleanupArm({
        schemaVersion: 1,
        arm: input.request.arm,
        attemptBindingContentSha256:
          input.request.attemptBinding.bindingContentSha256,
        isolation: input.request.isolation,
      }),
    );
    if (
      parsed.success &&
      parsed.data.arm === input.request.arm &&
      parsed.data.attemptBindingContentSha256 ===
        input.request.attemptBinding.bindingContentSha256
    ) {
      cleanup = parsed.data;
    } else {
      cleanupInfrastructureFailure = true;
      cleanupFailureCode = "cleanup_result_invalid";
    }
  } catch {
    cleanupInfrastructureFailure = true;
    cleanupFailureCode = "cleanup_threw";
  }

  let attemptEvidence: M7AgentAttemptEvidenceSidecarV1;
  if (input.port.sealAttemptEvidenceOnce === undefined) {
    attemptEvidence = fallbackAttemptEvidence({
      request: input.request,
      result,
      runnerFailureCode: infrastructureFailureCode,
      cleanupFailureCode,
      cleanup,
    });
  } else {
    try {
      const parsed = M7AgentAttemptEvidenceSidecarV1Schema.safeParse(
        await input.port.sealAttemptEvidenceOnce({
          schemaVersion: 1,
          arm: input.request.arm,
          campaignId: input.request.campaignId,
          attemptBindingContentSha256:
            input.request.attemptBinding.bindingContentSha256,
          runnerFailureCode: infrastructureFailureCode,
          cleanupFailureCode,
          cleanup,
        }),
      );
      if (
        !parsed.success ||
        parsed.data.arm !== input.request.arm ||
        parsed.data.campaignId !== input.request.campaignId ||
        parsed.data.attemptBindingContentSha256 !==
          input.request.attemptBinding.bindingContentSha256 ||
        !attemptEvidenceMatchesDisposition({
          evidence: parsed.data,
          runnerFailureCode: infrastructureFailureCode,
          cleanupFailureCode,
          cleanup,
        })
      ) {
        throw new TypeError("M7 attempt evidence crossed its binding");
      }
      attemptEvidence = parsed.data;
    } catch {
      result = null;
      infrastructureFailureCode = "runner_result_invalid";
      attemptEvidence = fallbackAttemptEvidence({
        request: input.request,
        result,
        runnerFailureCode: infrastructureFailureCode,
        cleanupFailureCode,
        cleanup,
        sealFailureCode: "result_invalid",
      });
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    arm: input.request.arm,
    binding: input.request.attemptBinding,
    result,
    infrastructureFailureCode,
    cleanup,
    cleanupInfrastructureFailure,
    attemptEvidence,
  });
};

export interface M7PairedAgentProtocolV1 {
  readonly schemaVersion: 1;
  readonly surfaceEqualityProof: M7PairedToolSurfaceEqualityProofV1;
  readonly runtimeRequest: M7PairedAgentArmRequestV1 & {
    readonly arm: "runtime_enabled";
  };
  readonly codeOnlyRequest: M7PairedAgentArmRequestV1 & {
    readonly arm: "code_only";
  };
}

/** Freezes both admissions without starting either Pi Session. */
export const createM7PairedAgentProtocolV1 = (
  untrustedInput: M7PairedAgentInputV1,
): M7PairedAgentProtocolV1 => {
  const input = pairedInputSchema.parse(untrustedInput);
  const adapterRevision: ProjectAdapterRevisionV1 =
    ProjectAdapterRevisionV1Schema.parse(input.pristineAdapterRevision);
  const gameTools = createM6AdmittedGameToolsV1({
    adapterRevision,
    hostAdmittedToolNames: input.hostAdmittedGameToolNames,
  });
  const proof = createSurfaceEqualityProof({
    campaignId: input.campaignId,
    publicTaskSpecSha256: input.publicTaskSpecSha256,
    runtimeArmPublicTaskSpecSha256: input.runtimeArmPublicTaskSpecSha256,
    codeOnlyArmPublicTaskSpecSha256: input.codeOnlyArmPublicTaskSpecSha256,
    prompt: input.prompt,
    provider: input.provider,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    agentBudget: input.agentBudget,
    baselineSelectedTreeSha256: input.baselineSelectedTreeSha256,
    commonEnvironmentInstructionsSha256:
      input.commonEnvironmentInstructionsSha256,
    hostModelRuntimeConfigSha256: input.hostModelRuntimeConfigSha256,
    codingTools: input.codingTools,
    sandboxProfileSha256: input.runtimeIsolation.sandboxProfileSha256,
    gameTools,
    runtimeResourceMap: input.runtimeResourceMap,
  });
  const runtimeSurface = runtimeSurfaceBindingSchema.parse({
    schemaVersion: 1,
    sensorFreezeRecordSha256: input.sensorFreezeRecordSha256,
    pristineAdapterRevisionId: adapterRevision.adapterRevisionId,
    pristineAdapterPackageSha256: adapterRevision.packageDigest,
    admittedGameToolSetSha256: proof.runtimeGameToolSetSha256,
    runtimeResourceMap: input.runtimeResourceMap,
    runtimeResourceAppendixSha256: proof.runtimeResourceAppendixSha256,
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
  if (runtimeRequest.arm !== "runtime_enabled") {
    throw new TypeError("M7 runtime admission was not runtime-enabled");
  }
  if (codeOnlyRequest.arm !== "code_only") {
    throw new TypeError("M7 code-only admission was not code-only");
  }
  return Object.freeze({
    schemaVersion: 1,
    surfaceEqualityProof: proof,
    runtimeRequest,
    codeOnlyRequest,
  });
};

/**
 * Executes the preregistered fixed-order ablation. A normal first-arm Agent
 * failure (provider failure, timeout, abort, or no candidate) never suppresses
 * the code-only arm. Only an infrastructure failure or an unproven cleanup
 * barrier stops the second isolated Session. There is no retry call site.
 */
export async function runM7PairedAgentArmsV1(
  untrustedInput: M7PairedAgentInputV1,
  port: M7PairedAgentPortV1,
): Promise<M7PairedAgentRunResultV1> {
  const protocol = createM7PairedAgentProtocolV1(untrustedInput);
  const { runtimeRequest, codeOnlyRequest } = protocol;

  const runtimeArm = await runM7PairedAgentArmOnceV1({
    request: runtimeRequest,
    port,
  });
  const attemptedOrder: M7PairedAgentArmV1[] = ["runtime_enabled"];
  if (runtimeArm.cleanupInfrastructureFailure || !runtimeArm.cleanup.proven) {
    return Object.freeze({
      schemaVersion: 1,
      status: "runtime_cleanup_failed",
      surfaceEqualityProof: protocol.surfaceEqualityProof,
      attemptedOrder: Object.freeze(attemptedOrder),
      runtimeArm,
      codeOnlyArm: null,
    });
  }
  if (runtimeArm.infrastructureFailureCode !== null) {
    return Object.freeze({
      schemaVersion: 1,
      status: "runtime_infrastructure_failure",
      surfaceEqualityProof: protocol.surfaceEqualityProof,
      attemptedOrder: Object.freeze(attemptedOrder),
      runtimeArm,
      codeOnlyArm: null,
    });
  }

  attemptedOrder.push("code_only");
  const codeOnlyArm = await runM7PairedAgentArmOnceV1({
    request: codeOnlyRequest,
    port,
  });
  const status =
    codeOnlyArm.cleanupInfrastructureFailure || !codeOnlyArm.cleanup.proven
      ? "code_only_cleanup_failed"
      : codeOnlyArm.infrastructureFailureCode !== null
        ? "code_only_infrastructure_failure"
        : "both_arms_recorded";
  return Object.freeze({
    schemaVersion: 1,
    status,
    surfaceEqualityProof: protocol.surfaceEqualityProof,
    attemptedOrder: Object.freeze(attemptedOrder),
    runtimeArm,
    codeOnlyArm,
  });
}
