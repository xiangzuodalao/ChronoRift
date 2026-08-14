import { z } from "zod";

import { Sha256DigestV1Schema } from "./hash.js";
import {
  AdapterIdSchema,
  BuildIdSchema,
  CaptureWindowIdSchema,
  ExecutionIdSchema,
  RuntimeIdSchema,
  SourceIdSchema,
  WorkspaceIdSchema,
  type ExecutionId,
  type Id,
  type TaskId,
} from "./ids.js";

const timestampSchema = z.string().datetime({ offset: true });
const counterSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const positiveCounterSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const boundedTextSchema = z.string().min(1).max(4_096);
const opaqueTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u)
  .refine((value) => !value.includes(".."), {
    message:
      "Project Environment identities are opaque and cannot contain path traversal",
  });

const projectOpaqueIdSchema = <Kind extends string>(): z.ZodType<Id<Kind>> =>
  opaqueTokenSchema as unknown as z.ZodType<Id<Kind>>;
const projectEnvironmentExecutionIdSchema =
  opaqueTokenSchema as unknown as z.ZodType<ExecutionId>;

export type ProjectEnvironmentId = Id<"ProjectEnvironmentId">;
export type ProjectEnvironmentRevisionId = Id<"ProjectEnvironmentRevisionId">;
export type ProjectAdapterRevisionId = Id<"ProjectAdapterRevisionId">;
export type ProjectAdapterCandidateId = Id<"ProjectAdapterCandidateId">;
export type ProjectInitializationAttemptId =
  Id<"ProjectInitializationAttemptId">;
export type ProjectInitializationAttemptEventId =
  Id<"ProjectInitializationAttemptEventId">;
export type ProjectEnvironmentTurnId = Id<"ProjectEnvironmentTurnId">;
export type EnvironmentBindingEpochId = Id<"EnvironmentBindingEpochId">;
export type ProjectEnvironmentOperationId = Id<"ProjectEnvironmentOperationId">;
export type ProjectSessionId = Id<"ProjectSessionId">;
export type ProjectEntityId = Id<"ProjectEntityId">;
export type ProjectResourceId = Id<"ProjectResourceId">;
export type ProjectToolchainReceiptId = Id<"ProjectToolchainReceiptId">;
export type AdapterConformanceReceiptId = Id<"AdapterConformanceReceiptId">;
export type AdapterCompatibilityReceiptId = Id<"AdapterCompatibilityReceiptId">;
export type ObserverEffectReceiptId = Id<"ObserverEffectReceiptId">;
export type EnvironmentPublicationReceiptId =
  Id<"EnvironmentPublicationReceiptId">;
export type ProjectEnvironmentReuseReceiptId =
  Id<"ProjectEnvironmentReuseReceiptId">;
export type ProjectEnvironmentRuntimeObservationReceiptId =
  Id<"ProjectEnvironmentRuntimeObservationReceiptId">;

export const ProjectEnvironmentIdSchema =
  projectOpaqueIdSchema<"ProjectEnvironmentId">();
export const ProjectEnvironmentTaskIdSchema =
  opaqueTokenSchema as unknown as z.ZodType<TaskId>;
export const ProjectEnvironmentRevisionIdSchema =
  projectOpaqueIdSchema<"ProjectEnvironmentRevisionId">();
export const ProjectAdapterRevisionIdSchema =
  projectOpaqueIdSchema<"ProjectAdapterRevisionId">();
export const ProjectAdapterCandidateIdSchema =
  projectOpaqueIdSchema<"ProjectAdapterCandidateId">();
export const ProjectInitializationAttemptIdSchema =
  projectOpaqueIdSchema<"ProjectInitializationAttemptId">();
export const ProjectInitializationAttemptEventIdSchema =
  projectOpaqueIdSchema<"ProjectInitializationAttemptEventId">();
export const ProjectEnvironmentTurnIdSchema =
  projectOpaqueIdSchema<"ProjectEnvironmentTurnId">();
export const EnvironmentBindingEpochIdSchema =
  projectOpaqueIdSchema<"EnvironmentBindingEpochId">();
export const ProjectEnvironmentOperationIdSchema =
  projectOpaqueIdSchema<"ProjectEnvironmentOperationId">();
export const ProjectSessionIdSchema =
  projectOpaqueIdSchema<"ProjectSessionId">();
export const ProjectEntityIdSchema = projectOpaqueIdSchema<"ProjectEntityId">();
export const ProjectResourceIdSchema =
  projectOpaqueIdSchema<"ProjectResourceId">();
export const ProjectToolchainReceiptIdSchema =
  projectOpaqueIdSchema<"ProjectToolchainReceiptId">();
export const AdapterConformanceReceiptIdSchema =
  projectOpaqueIdSchema<"AdapterConformanceReceiptId">();
export const AdapterCompatibilityReceiptIdSchema =
  projectOpaqueIdSchema<"AdapterCompatibilityReceiptId">();
export const ObserverEffectReceiptIdSchema =
  projectOpaqueIdSchema<"ObserverEffectReceiptId">();
export const EnvironmentPublicationReceiptIdSchema =
  projectOpaqueIdSchema<"EnvironmentPublicationReceiptId">();
export const ProjectEnvironmentReuseReceiptIdSchema =
  projectOpaqueIdSchema<"ProjectEnvironmentReuseReceiptId">();
export const ProjectEnvironmentRuntimeObservationReceiptIdSchema =
  projectOpaqueIdSchema<"ProjectEnvironmentRuntimeObservationReceiptId">();

export const asProjectEnvironmentId = (value: string): ProjectEnvironmentId =>
  ProjectEnvironmentIdSchema.parse(value);
export const asProjectEnvironmentTaskId = (value: string): TaskId =>
  ProjectEnvironmentTaskIdSchema.parse(value);
export const asProjectEnvironmentRevisionId = (
  value: string,
): ProjectEnvironmentRevisionId =>
  ProjectEnvironmentRevisionIdSchema.parse(value);
export const asProjectAdapterRevisionId = (
  value: string,
): ProjectAdapterRevisionId => ProjectAdapterRevisionIdSchema.parse(value);
export const asProjectAdapterCandidateId = (
  value: string,
): ProjectAdapterCandidateId => ProjectAdapterCandidateIdSchema.parse(value);
export const asProjectInitializationAttemptId = (
  value: string,
): ProjectInitializationAttemptId =>
  ProjectInitializationAttemptIdSchema.parse(value);
export const asProjectInitializationAttemptEventId = (
  value: string,
): ProjectInitializationAttemptEventId =>
  ProjectInitializationAttemptEventIdSchema.parse(value);
export const asProjectEnvironmentTurnId = (
  value: string,
): ProjectEnvironmentTurnId => ProjectEnvironmentTurnIdSchema.parse(value);
export const asEnvironmentBindingEpochId = (
  value: string,
): EnvironmentBindingEpochId => EnvironmentBindingEpochIdSchema.parse(value);
export const asProjectEnvironmentOperationId = (
  value: string,
): ProjectEnvironmentOperationId =>
  ProjectEnvironmentOperationIdSchema.parse(value);
export const asProjectSessionId = (value: string): ProjectSessionId =>
  ProjectSessionIdSchema.parse(value);
export const asProjectEntityId = (value: string): ProjectEntityId =>
  ProjectEntityIdSchema.parse(value);
export const asProjectResourceId = (value: string): ProjectResourceId =>
  ProjectResourceIdSchema.parse(value);
export const asProjectToolchainReceiptId = (
  value: string,
): ProjectToolchainReceiptId => ProjectToolchainReceiptIdSchema.parse(value);
export const asAdapterConformanceReceiptId = (
  value: string,
): AdapterConformanceReceiptId =>
  AdapterConformanceReceiptIdSchema.parse(value);
export const asAdapterCompatibilityReceiptId = (
  value: string,
): AdapterCompatibilityReceiptId =>
  AdapterCompatibilityReceiptIdSchema.parse(value);
export const asObserverEffectReceiptId = (
  value: string,
): ObserverEffectReceiptId => ObserverEffectReceiptIdSchema.parse(value);
export const asEnvironmentPublicationReceiptId = (
  value: string,
): EnvironmentPublicationReceiptId =>
  EnvironmentPublicationReceiptIdSchema.parse(value);
export const asProjectEnvironmentReuseReceiptId = (
  value: string,
): ProjectEnvironmentReuseReceiptId =>
  ProjectEnvironmentReuseReceiptIdSchema.parse(value);
export const asProjectEnvironmentRuntimeObservationReceiptId = (
  value: string,
): ProjectEnvironmentRuntimeObservationReceiptId =>
  ProjectEnvironmentRuntimeObservationReceiptIdSchema.parse(value);

export type CanonicalAdapterTaggedValueV1 =
  | {
      readonly $type:
        | "vector2"
        | "vector3"
        | "vector4"
        | "quaternion"
        | "basis"
        | "transform2d"
        | "transform3d"
        | "color"
        | "rect2";
      readonly values: readonly number[];
    }
  | { readonly $type: "entity_ref"; readonly entityId: ProjectEntityId }
  | { readonly $type: "resource_ref"; readonly resourceId: ProjectResourceId };

export type CanonicalAdapterValueV1 =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalAdapterValueV1[]
  | { readonly [key: string]: CanonicalAdapterValueV1 }
  | CanonicalAdapterTaggedValueV1;

export const CANONICAL_ADAPTER_VALUE_LIMITS_V1 = Object.freeze({
  maximumDepth: 32,
  maximumNodes: 4_096,
  maximumContainerEntries: 256,
  maximumStringLength: 16_384,
  maximumKeyLength: 256,
});

const taggedValueLengths = new Map<string, number>([
  ["vector2", 2],
  ["vector3", 3],
  ["vector4", 4],
  ["quaternion", 4],
  ["basis", 9],
  ["transform2d", 6],
  ["transform3d", 12],
  ["color", 4],
  ["rect2", 4],
]);

const canonicalNumberIsValid = (value: number): boolean =>
  Number.isFinite(value) &&
  !Object.is(value, -0) &&
  (!Number.isInteger(value) || Number.isSafeInteger(value));

const validateCanonicalAdapterValue = (
  input: unknown,
  context: z.core.$RefinementCtx,
): void => {
  let nodes = 0;
  const ancestors = new Set<object>();

  const issue = (
    path: PropertyKey[],
    message: string,
    value: unknown,
  ): void => {
    context.addIssue({ code: "custom", path, message, input: value });
  };

  const visit = (value: unknown, depth: number, path: PropertyKey[]): void => {
    nodes += 1;
    if (nodes > CANONICAL_ADAPTER_VALUE_LIMITS_V1.maximumNodes) {
      issue(path, "canonical adapter value exceeds the node budget", value);
      return;
    }
    if (depth > CANONICAL_ADAPTER_VALUE_LIMITS_V1.maximumDepth) {
      issue(path, "canonical adapter value exceeds the depth budget", value);
      return;
    }
    if (value === null || typeof value === "boolean") {
      return;
    }
    if (typeof value === "string") {
      if (
        value.length > CANONICAL_ADAPTER_VALUE_LIMITS_V1.maximumStringLength
      ) {
        issue(path, "canonical adapter string exceeds its bound", value);
      }
      return;
    }
    if (typeof value === "number") {
      if (!canonicalNumberIsValid(value)) {
        issue(
          path,
          "canonical adapter numbers must be finite, safe when integral, and not negative zero",
          value,
        );
      }
      return;
    }
    if (typeof value !== "object" || value === undefined) {
      issue(
        path,
        "value is not part of the canonical adapter value model",
        value,
      );
      return;
    }
    if (ancestors.has(value)) {
      issue(path, "canonical adapter values cannot contain cycles", value);
      return;
    }
    ancestors.add(value);
    if (Array.isArray(value)) {
      if (
        value.length > CANONICAL_ADAPTER_VALUE_LIMITS_V1.maximumContainerEntries
      ) {
        issue(path, "canonical adapter array exceeds its entry bound", value);
      }
      for (const [index, child] of value.entries()) {
        visit(child, depth + 1, [...path, index]);
      }
      ancestors.delete(value);
      return;
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      issue(path, "canonical adapter maps must be plain objects", value);
      ancestors.delete(value);
      return;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
      keys.length > CANONICAL_ADAPTER_VALUE_LIMITS_V1.maximumContainerEntries
    ) {
      issue(path, "canonical adapter map exceeds its entry bound", value);
    }
    for (const key of keys) {
      if (
        key.length === 0 ||
        key.length > CANONICAL_ADAPTER_VALUE_LIMITS_V1.maximumKeyLength
      ) {
        issue(
          [...path, key],
          "canonical adapter map key is outside its bound",
          key,
        );
      }
    }
    if (Object.hasOwn(record, "$type")) {
      const tag = record.$type;
      if (tag === "entity_ref" || tag === "resource_ref") {
        const referenceKey = tag === "entity_ref" ? "entityId" : "resourceId";
        if (
          keys.length !== 2 ||
          !keys.includes(referenceKey) ||
          !opaqueTokenSchema.safeParse(record[referenceKey]).success
        ) {
          issue(
            path,
            `${tag} must contain exactly one bounded opaque reference`,
            value,
          );
        }
        ancestors.delete(value);
        return;
      }
      const expectedLength =
        typeof tag === "string" ? taggedValueLengths.get(tag) : undefined;
      if (
        expectedLength === undefined ||
        keys.length !== 2 ||
        !keys.includes("values") ||
        !Array.isArray(record.values) ||
        record.values.length !== expectedLength ||
        !record.values.every(
          (entry) => typeof entry === "number" && canonicalNumberIsValid(entry),
        )
      ) {
        issue(
          path,
          "tagged adapter value has an unknown tag or invalid canonical payload",
          value,
        );
      }
      ancestors.delete(value);
      return;
    }
    for (const key of keys) {
      visit(record[key], depth + 1, [...path, key]);
    }
    ancestors.delete(value);
  };

  visit(input, 0, []);
};

export const CanonicalAdapterValueV1Schema: z.ZodType<CanonicalAdapterValueV1> =
  z
    .unknown()
    .superRefine(
      validateCanonicalAdapterValue,
    ) as z.ZodType<CanonicalAdapterValueV1>;

export const asCanonicalAdapterValueV1 = (
  value: unknown,
): CanonicalAdapterValueV1 => CanonicalAdapterValueV1Schema.parse(value);

export const ProjectCapabilityModuleNameV1Schema = z.enum([
  "lifecycle",
  "clock",
  "runtime_error",
  "entity_projection",
  "state_projection",
  "event_projection",
  "capture",
  "input_control",
  "snapshot",
  "restore",
  "render_capture",
  "alignment",
]);
export type ProjectCapabilityModuleNameV1 = z.infer<
  typeof ProjectCapabilityModuleNameV1Schema
>;

export const PROJECT_CAPABILITY_MODULE_NAMES_V1 = Object.freeze(
  ProjectCapabilityModuleNameV1Schema.options,
);
export const PROJECT_READY_REQUIRED_MODULE_NAMES_V1 = Object.freeze([
  "lifecycle",
  "clock",
  "runtime_error",
  "entity_projection",
  "state_projection",
  "event_projection",
  "capture",
] as const satisfies readonly ProjectCapabilityModuleNameV1[]);

export const ProjectCapabilityStateV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    module: ProjectCapabilityModuleNameV1Schema,
    status: z.enum([
      "implemented",
      "unsupported",
      "unavailable_by_policy",
      "unavailable_by_environment",
      "degraded",
    ]),
    protocolVersion: opaqueTokenSchema.nullable(),
    limitations: z.array(boundedTextSchema).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.status === "implemented" || value.status === "degraded") &&
      value.protocolVersion === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["protocolVersion"],
        message: "implemented and degraded modules require a protocol version",
        input: value.protocolVersion,
      });
    }
    if (value.status === "implemented" && value.limitations.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["limitations"],
        message: "an implemented module cannot carry degradation limitations",
        input: value.limitations,
      });
    }
    if (value.status !== "implemented" && value.limitations.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["limitations"],
        message:
          "non-implemented capability states require an explicit limitation",
        input: value.limitations,
      });
    }
  });
export type ProjectCapabilityStateV1 = z.infer<
  typeof ProjectCapabilityStateV1Schema
>;

export const ProjectCapabilitySetV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    modules: z.array(ProjectCapabilityStateV1Schema).length(12),
  })
  .strict()
  .superRefine((value, context) => {
    const names = value.modules.map((module) => module.module);
    if (
      new Set(names).size !== PROJECT_CAPABILITY_MODULE_NAMES_V1.length ||
      PROJECT_CAPABILITY_MODULE_NAMES_V1.some((name) => !names.includes(name))
    ) {
      context.addIssue({
        code: "custom",
        path: ["modules"],
        message: "capability set must contain every module exactly once",
        input: names,
      });
    }
  });
export type ProjectCapabilitySetV1 = z.infer<
  typeof ProjectCapabilitySetV1Schema
>;

export const ProjectStateDomainDispositionV1Schema = z.enum([
  "captured",
  "reset",
  "externally_controlled",
  "unsupported",
  "uncontrolled",
]);
export type ProjectStateDomainDispositionV1 = z.infer<
  typeof ProjectStateDomainDispositionV1Schema
>;

export const ProjectStateDomainCapabilityV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    domainId: opaqueTokenSchema,
    disposition: ProjectStateDomainDispositionV1Schema,
    schemaDigest: Sha256DigestV1Schema.nullable(),
    limitations: z.array(boundedTextSchema).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.disposition === "captured" && value.schemaDigest === null) {
      context.addIssue({
        code: "custom",
        path: ["schemaDigest"],
        message: "captured state domains require a schema digest",
        input: value.schemaDigest,
      });
    }
    if (value.disposition !== "captured" && value.limitations.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["limitations"],
        message: "non-captured state domains require an explicit limitation",
        input: value.limitations,
      });
    }
  });
export type ProjectStateDomainCapabilityV1 = z.infer<
  typeof ProjectStateDomainCapabilityV1Schema
>;

export const ProjectAdapterCandidateReferenceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: ProjectEnvironmentTaskIdSchema,
    attemptId: ProjectInitializationAttemptIdSchema,
    candidateId: ProjectAdapterCandidateIdSchema,
    adapterId: AdapterIdSchema,
    sourceId: SourceIdSchema,
    contentDigest: Sha256DigestV1Schema,
    fileCount: positiveCounterSchema.max(256),
    byteLength: positiveCounterSchema.max(8_388_608),
    frozenAt: timestampSchema,
  })
  .strict();
export type ProjectAdapterCandidateReferenceV1 = z.infer<
  typeof ProjectAdapterCandidateReferenceV1Schema
>;

export const ProjectTurnBudgetV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    wallTimeMs: positiveCounterSchema,
    toolCallLimit: positiveCounterSchema,
    runtimeTimeMs: positiveCounterSchema,
    tokenPolicy: z.enum(["observe_only", "limited"]),
    tokenLimit: positiveCounterSchema.nullable(),
    storageByteLimit: positiveCounterSchema,
    storageInodeLimit: positiveCounterSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.tokenPolicy === "observe_only") !==
      (value.tokenLimit === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["tokenLimit"],
        message:
          "observe-only tokens have no limit and limited tokens require one",
        input: value.tokenLimit,
      });
    }
  });
export type ProjectTurnBudgetV1 = z.infer<typeof ProjectTurnBudgetV1Schema>;

export const ProjectTurnUsageV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    wallTimeMs: counterSchema.nullable(),
    toolCalls: counterSchema.nullable(),
    runtimeTimeMs: counterSchema.nullable(),
    inputTokens: counterSchema.nullable(),
    outputTokens: counterSchema.nullable(),
    storageBytes: counterSchema.nullable(),
    storageInodes: counterSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      [
        value.wallTimeMs,
        value.toolCalls,
        value.runtimeTimeMs,
        value.inputTokens,
        value.outputTokens,
        value.storageBytes,
        value.storageInodes,
      ].every((observed) => observed === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["wallTimeMs"],
        message:
          "turn usage with no observed counters must be represented as unavailable",
        input: value.wallTimeMs,
      });
    }
  });
export type ProjectTurnUsageV1 = z.infer<typeof ProjectTurnUsageV1Schema>;

export const ProjectToolchainRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    engineFamily: opaqueTokenSchema,
    versionRequirement: z.string().min(1).max(256),
    platform: opaqueTokenSchema,
    requiredFeatures: z.array(opaqueTokenSchema).max(64),
  })
  .strict();
export type ProjectToolchainRequestV1 = z.infer<
  typeof ProjectToolchainRequestV1Schema
>;

export const ProjectToolchainRealizationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    engineFamily: opaqueTokenSchema,
    version: z.string().min(1).max(256),
    platform: opaqueTokenSchema,
    artifactDigest: Sha256DigestV1Schema,
    features: z.array(opaqueTokenSchema).max(64),
    renderer: opaqueTokenSchema,
  })
  .strict();
export type ProjectToolchainRealizationV1 = z.infer<
  typeof ProjectToolchainRealizationV1Schema
>;

export const ProjectToolchainReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    receiptId: ProjectToolchainReceiptIdSchema,
    requested: ProjectToolchainRequestV1Schema,
    status: z.enum(["realized", "unavailable", "mismatched"]),
    realized: ProjectToolchainRealizationV1Schema.nullable(),
    limitations: z.array(boundedTextSchema).max(64),
    observedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.status === "realized") !== (value.realized !== null)) {
      context.addIssue({
        code: "custom",
        path: ["realized"],
        message: "only a realized toolchain receipt carries a realization",
        input: value.realized,
      });
    }
    if (value.status !== "realized" && value.limitations.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["limitations"],
        message: "unavailable or mismatched toolchains require an explanation",
        input: value.limitations,
      });
    }
  });
export type ProjectToolchainReceiptV1 = z.infer<
  typeof ProjectToolchainReceiptV1Schema
>;

export const ProjectRuntimeCleanupReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    processTreeTerminated: z.boolean(),
    runtimeExited: z.boolean(),
    bridgeExited: z.boolean(),
    isolationGroupEmpty: z.boolean(),
    scopeRemoved: z.boolean(),
    scratchRemoved: z.boolean(),
    storageReconciled: z.boolean(),
  })
  .strict();
export type ProjectRuntimeCleanupReceiptV1 = z.infer<
  typeof ProjectRuntimeCleanupReceiptV1Schema
>;

export const projectRuntimeCleanupCompleteV1 = (
  value: ProjectRuntimeCleanupReceiptV1,
): boolean =>
  value.processTreeTerminated &&
  value.runtimeExited &&
  value.bridgeExited &&
  value.isolationGroupEmpty &&
  value.scopeRemoved &&
  value.scratchRemoved &&
  value.storageReconciled;

export const ProjectObservationCoverageV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    channelId: opaqueTokenSchema,
    status: z.enum(["complete", "sampled", "incomplete", "unavailable"]),
    observedRecords: counterSchema,
    droppedRecords: counterSchema,
    overwrittenRecords: counterSchema,
    limitations: z.array(boundedTextSchema).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    const hasLoss = value.droppedRecords > 0 || value.overwrittenRecords > 0;
    if (hasLoss && value.status === "complete") {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "coverage with loss cannot be complete",
        input: value.status,
      });
    }
    if (value.status !== "complete" && value.limitations.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["limitations"],
        message: "non-complete coverage requires an explicit limitation",
        input: value.limitations,
      });
    }
  });
export type ProjectObservationCoverageV1 = z.infer<
  typeof ProjectObservationCoverageV1Schema
>;

export const ProjectObservationLossV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    channelId: opaqueTokenSchema,
    kind: z.enum([
      "sampled",
      "dropped",
      "overwritten",
      "unavailable",
      "observer_effect",
    ]),
    count: positiveCounterSchema,
    reason: boundedTextSchema,
  })
  .strict();
export type ProjectObservationLossV1 = z.infer<
  typeof ProjectObservationLossV1Schema
>;

export const ProjectEnvironmentRuntimeClockV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    processFrame: counterSchema,
    physicsTick: counterSchema,
    simulationTimeUs: counterSchema,
    renderFrame: counterSchema.nullable(),
    hostMonotonicUs: counterSchema,
  })
  .strict();
export type ProjectEnvironmentRuntimeClockV1 = z.infer<
  typeof ProjectEnvironmentRuntimeClockV1Schema
>;

/**
 * Engine-neutral identity and runtime-truth manifest for one durable pinned
 * Project Environment observation batch. The records themselves remain
 * untrusted JSON and are stored separately under this manifest's digest.
 */
export const ProjectEnvironmentPinnedCaptureV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    captureWindowId: CaptureWindowIdSchema,
    taskId: ProjectEnvironmentTaskIdSchema,
    runtimeId: RuntimeIdSchema,
    executionId: projectEnvironmentExecutionIdSchema,
    buildId: BuildIdSchema,
    environmentRevisionId: ProjectEnvironmentRevisionIdSchema,
    adapterRevisionId: ProjectAdapterRevisionIdSchema,
    recordCount: positiveCounterSchema,
    contentDigest: Sha256DigestV1Schema,
    anchorClock: ProjectEnvironmentRuntimeClockV1Schema,
    coverage: z.array(ProjectObservationCoverageV1Schema).min(1).max(256),
    loss: z.array(ProjectObservationLossV1Schema).max(2_000),
    createdAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const coverageByChannel = new Map<
      string,
      (typeof value.coverage)[number]
    >();
    for (const [index, entry] of value.coverage.entries()) {
      if (coverageByChannel.has(entry.channelId)) {
        context.addIssue({
          code: "custom",
          path: ["coverage", index, "channelId"],
          message: "pinned capture coverage channels must be unique",
          input: entry.channelId,
        });
      }
      coverageByChannel.set(entry.channelId, entry);
    }
    for (const [index, entry] of value.loss.entries()) {
      const channel = coverageByChannel.get(entry.channelId);
      if (channel === undefined) {
        context.addIssue({
          code: "custom",
          path: ["loss", index, "channelId"],
          message: "pinned capture loss must reference a covered channel",
          input: entry.channelId,
        });
      } else if (channel.status === "complete") {
        context.addIssue({
          code: "custom",
          path: ["loss", index],
          message: "complete pinned capture coverage cannot report loss",
          input: entry,
        });
      }
    }
  });
export type ProjectEnvironmentPinnedCaptureV1 = z.infer<
  typeof ProjectEnvironmentPinnedCaptureV1Schema
>;

export const ProjectEnvironmentRuntimeObservationReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    receiptId: ProjectEnvironmentRuntimeObservationReceiptIdSchema,
    taskId: ProjectEnvironmentTaskIdSchema,
    runtimeId: RuntimeIdSchema,
    executionId: ExecutionIdSchema,
    buildId: BuildIdSchema,
    environmentRevisionId: ProjectEnvironmentRevisionIdSchema,
    adapterRevisionId: ProjectAdapterRevisionIdSchema,
    launchTargetId: opaqueTokenSchema,
    instrumentationMode: z.literal("instrumented"),
    status: z.literal("stopped"),
    bridgeHandshakeCount: counterSchema,
    clock: ProjectEnvironmentRuntimeClockV1Schema.nullable(),
    queryObservations: z
      .object({
        schemaVersion: z.literal(1),
        entityQueryCount: counterSchema,
        entityRows: counterSchema,
        stateQueryCount: counterSchema,
        stateRows: counterSchema,
      })
      .strict(),
    captureCount: counterSchema,
    captureWindowIds: z.array(CaptureWindowIdSchema).max(2_000),
    coverage: z.array(ProjectObservationCoverageV1Schema).min(1).max(256),
    loss: z.array(ProjectObservationLossV1Schema).max(2_000),
    cleanup: ProjectRuntimeCleanupReceiptV1Schema,
    outcome: z.enum(["succeeded", "incomplete"]),
    failures: z.array(boundedTextSchema).max(256),
    startedAt: timestampSchema,
    observedAt: timestampSchema,
    completedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const captureWindowIds = new Set(value.captureWindowIds);
    if (captureWindowIds.size !== value.captureWindowIds.length) {
      context.addIssue({
        code: "custom",
        path: ["captureWindowIds"],
        message: "runtime observation capture window IDs must be unique",
        input: value.captureWindowIds,
      });
    }
    if (value.captureCount !== value.captureWindowIds.length) {
      context.addIssue({
        code: "custom",
        path: ["captureCount"],
        message:
          "runtime observation capture count must equal its durable capture window IDs",
        input: value.captureCount,
      });
    }
    const coverageComplete = value.coverage.every(
      (entry) =>
        entry.status === "complete" &&
        entry.observedRecords > 0 &&
        entry.droppedRecords === 0 &&
        entry.overwrittenRecords === 0,
    );
    const succeeded =
      value.bridgeHandshakeCount > 0 &&
      value.clock !== null &&
      value.queryObservations.entityQueryCount > 0 &&
      value.queryObservations.entityRows > 0 &&
      value.queryObservations.stateQueryCount > 0 &&
      value.queryObservations.stateRows > 0 &&
      value.captureCount > 0 &&
      coverageComplete &&
      value.loss.length === 0 &&
      projectRuntimeCleanupCompleteV1(value.cleanup) &&
      value.failures.length === 0;
    if ((value.outcome === "succeeded") !== succeeded) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message:
          "runtime observation success requires instrumented handshake, nonempty entity/state queries, a pinned capture, complete lossless coverage, complete cleanup, and no failures",
        input: value.outcome,
      });
    }
    if (value.outcome === "incomplete" && value.failures.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["failures"],
        message: "incomplete runtime observation requires an explicit failure",
        input: value.failures,
      });
    }
    if (
      value.queryObservations.entityRows > 0 &&
      value.queryObservations.entityQueryCount === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["queryObservations", "entityRows"],
        message: "entity rows require at least one entity query",
        input: value.queryObservations.entityRows,
      });
    }
    if (
      value.queryObservations.stateRows > 0 &&
      value.queryObservations.stateQueryCount === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["queryObservations", "stateRows"],
        message: "state rows require at least one state query",
        input: value.queryObservations.stateRows,
      });
    }
    const startedAt = Date.parse(value.startedAt);
    const observedAt = Date.parse(value.observedAt);
    const completedAt = Date.parse(value.completedAt);
    if (startedAt > observedAt || observedAt > completedAt) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message:
          "runtime observation timestamps must be ordered from launch through observation and cleanup",
        input: value.completedAt,
      });
    }
  });
export type ProjectEnvironmentRuntimeObservationReceiptV1 = z.infer<
  typeof ProjectEnvironmentRuntimeObservationReceiptV1Schema
>;

export const AdapterConformanceObservationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    bridgeHandshakes: counterSchema,
    entityLifecycleRecords: counterSchema,
    stateSamples: counterSchema,
    queries: counterSchema,
    declaredCustomEventTypes: counterSchema,
    observedCustomEventTypes: counterSchema,
    captures: counterSchema,
  })
  .strict()
  .refine(
    (value) => value.observedCustomEventTypes <= value.declaredCustomEventTypes,
    {
      path: ["observedCustomEventTypes"],
      message: "observed custom event type count cannot exceed declarations",
    },
  );
export type AdapterConformanceObservationV1 = z.infer<
  typeof AdapterConformanceObservationV1Schema
>;

export const AdapterConformanceReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    receiptId: AdapterConformanceReceiptIdSchema,
    taskId: ProjectEnvironmentTaskIdSchema,
    attemptId: ProjectInitializationAttemptIdSchema,
    sourceId: SourceIdSchema,
    candidateId: ProjectAdapterCandidateIdSchema,
    candidateDigest: Sha256DigestV1Schema,
    toolchainReceiptId: ProjectToolchainReceiptIdSchema,
    capabilitySet: ProjectCapabilitySetV1Schema,
    stateDomains: z.array(ProjectStateDomainCapabilityV1Schema).max(256),
    observations: AdapterConformanceObservationV1Schema,
    coverage: z.array(ProjectObservationCoverageV1Schema).max(256),
    cleanup: ProjectRuntimeCleanupReceiptV1Schema,
    outcome: z.enum(["conformed", "rejected"]),
    failures: z.array(boundedTextSchema).max(256),
    startedAt: timestampSchema,
    completedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const moduleByName = new Map(
      value.capabilitySet.modules.map((module) => [module.module, module]),
    );
    const requiredImplemented = PROJECT_READY_REQUIRED_MODULE_NAMES_V1.every(
      (name) => moduleByName.get(name)?.status === "implemented",
    );
    const minimumObserved =
      value.observations.bridgeHandshakes > 0 &&
      value.observations.entityLifecycleRecords > 0 &&
      value.observations.stateSamples > 0 &&
      value.observations.queries > 0 &&
      value.observations.captures > 0 &&
      value.stateDomains.length > 0 &&
      value.observations.observedCustomEventTypes ===
        value.observations.declaredCustomEventTypes;
    const completeCoverage =
      value.coverage.length > 0 &&
      value.coverage.every(
        (entry) =>
          entry.status === "complete" &&
          entry.observedRecords > 0 &&
          entry.droppedRecords === 0 &&
          entry.overwrittenRecords === 0,
      );
    const conformed =
      requiredImplemented &&
      minimumObserved &&
      completeCoverage &&
      projectRuntimeCleanupCompleteV1(value.cleanup) &&
      value.failures.length === 0;
    if ((value.outcome === "conformed") !== conformed) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message:
          "conformance outcome must match required capabilities, observations, cleanup, and failures",
        input: value.outcome,
      });
    }
  });
export type AdapterConformanceReceiptV1 = z.infer<
  typeof AdapterConformanceReceiptV1Schema
>;

export const ObserverEffectDifferenceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    comparison: z.enum(["vanilla_to_bridge", "bridge_to_instrumented"]),
    dimension: opaqueTokenSchema,
    baselineDigest: Sha256DigestV1Schema.nullable(),
    instrumentedDigest: Sha256DigestV1Schema.nullable(),
    description: boundedTextSchema,
  })
  .strict();
export type ObserverEffectDifferenceV1 = z.infer<
  typeof ObserverEffectDifferenceV1Schema
>;

export const ObserverEffectReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    receiptId: ObserverEffectReceiptIdSchema,
    taskId: ProjectEnvironmentTaskIdSchema,
    attemptId: ProjectInitializationAttemptIdSchema,
    sourceId: SourceIdSchema,
    candidateId: ProjectAdapterCandidateIdSchema,
    status: z.enum(["measured", "incomplete"]),
    differences: z.array(ObserverEffectDifferenceV1Schema).max(256),
    alignmentGaps: z.array(boundedTextSchema).max(256),
    unknowns: z.array(boundedTextSchema).max(256),
    observedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.status === "incomplete" &&
      value.alignmentGaps.length === 0 &&
      value.unknowns.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "incomplete observer-effect measurement must expose its gap",
        input: value.status,
      });
    }
  });
export type ObserverEffectReceiptV1 = z.infer<
  typeof ObserverEffectReceiptV1Schema
>;

export const ProjectAdapterRevisionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    adapterRevisionId: ProjectAdapterRevisionIdSchema,
    adapterId: AdapterIdSchema,
    sourceId: SourceIdSchema,
    packageDigest: Sha256DigestV1Schema,
    manifestDigest: Sha256DigestV1Schema,
    implementationDigest: Sha256DigestV1Schema,
    payloadSchemaDigest: Sha256DigestV1Schema,
    sdkDigest: Sha256DigestV1Schema,
    bridgeDigest: Sha256DigestV1Schema,
    capabilitySet: ProjectCapabilitySetV1Schema,
    conformanceReceiptId: AdapterConformanceReceiptIdSchema,
    contentByteLength: positiveCounterSchema,
    contentFileCount: positiveCounterSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const byName = new Map(
      value.capabilitySet.modules.map((module) => [
        module.module,
        module.status,
      ]),
    );
    if (
      PROJECT_READY_REQUIRED_MODULE_NAMES_V1.some(
        (module) => byName.get(module) !== "implemented",
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["capabilitySet"],
        message:
          "a published adapter revision must implement every Ready module",
        input: value.capabilitySet,
      });
    }
  });
export type ProjectAdapterRevisionV1 = z.infer<
  typeof ProjectAdapterRevisionV1Schema
>;

export const ProjectEnvironmentRevisionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    environmentId: ProjectEnvironmentIdSchema,
    environmentRevisionId: ProjectEnvironmentRevisionIdSchema,
    sourceId: SourceIdSchema,
    adapterRevisionId: ProjectAdapterRevisionIdSchema,
    sdkDigest: Sha256DigestV1Schema,
    bridgeDigest: Sha256DigestV1Schema,
    toolchainReceiptId: ProjectToolchainReceiptIdSchema,
    conformanceReceiptId: AdapterConformanceReceiptIdSchema,
    observerEffectReceiptId: ObserverEffectReceiptIdSchema,
    policyProfileDigest: Sha256DigestV1Schema,
    publicationOperationId: ProjectEnvironmentOperationIdSchema,
    contentDigest: Sha256DigestV1Schema,
    publishedAt: timestampSchema,
  })
  .strict();
export type ProjectEnvironmentRevisionV1 = z.infer<
  typeof ProjectEnvironmentRevisionV1Schema
>;

export const ProjectEnvironmentRevisionReferenceV1Schema =
  ProjectEnvironmentRevisionV1Schema.pick({
    schemaVersion: true,
    environmentId: true,
    environmentRevisionId: true,
    sourceId: true,
    adapterRevisionId: true,
    sdkDigest: true,
    bridgeDigest: true,
    toolchainReceiptId: true,
    conformanceReceiptId: true,
    observerEffectReceiptId: true,
    policyProfileDigest: true,
    contentDigest: true,
  }).strict();
export type ProjectEnvironmentRevisionReferenceV1 = z.infer<
  typeof ProjectEnvironmentRevisionReferenceV1Schema
>;

export const ProjectEnvironmentV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    environmentId: ProjectEnvironmentIdSchema,
    inspectedSourceId: SourceIdSchema,
    state: z.enum(["uninitialized", "ready", "review_required"]),
    current: ProjectEnvironmentRevisionReferenceV1Schema.nullable(),
    reviewReasons: z.array(boundedTextSchema).max(64),
    inspectedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.current !== null &&
      value.current.environmentId !== value.environmentId
    ) {
      context.addIssue({
        code: "custom",
        path: ["current", "environmentId"],
        message: "current revision must belong to the inspected environment",
        input: value.current.environmentId,
      });
    }
    if (value.state === "uninitialized" && value.current !== null) {
      context.addIssue({
        code: "custom",
        path: ["current"],
        message: "an uninitialized environment cannot have a current revision",
        input: value.current,
      });
    }
    if (value.state !== "uninitialized" && value.current === null) {
      context.addIssue({
        code: "custom",
        path: ["current"],
        message:
          "ready or review-required environments need a current revision",
        input: value.current,
      });
    }
    if (
      value.state === "ready" &&
      (value.reviewReasons.length > 0 ||
        value.current?.sourceId !== value.inspectedSourceId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "ready requires an exact source binding and no review reason",
        input: value.state,
      });
    }
    if (value.state === "review_required" && value.reviewReasons.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["reviewReasons"],
        message: "review-required environments must expose at least one reason",
        input: value.reviewReasons,
      });
    }
  });
export type ProjectEnvironmentV1 = z.infer<typeof ProjectEnvironmentV1Schema>;

export const AdapterCompatibilityReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    receiptId: AdapterCompatibilityReceiptIdSchema,
    taskId: ProjectEnvironmentTaskIdSchema,
    buildId: BuildIdSchema,
    sourceId: SourceIdSchema,
    environmentRevisionId: ProjectEnvironmentRevisionIdSchema,
    adapterRevisionId: ProjectAdapterRevisionIdSchema,
    toolchainReceiptId: ProjectToolchainReceiptIdSchema,
    bridgeHandshakeObserved: z.boolean(),
    instrumentedLaunchObserved: z.boolean(),
    queryObservations: z
      .object({
        schemaVersion: z.literal(1),
        entityQueryObserved: z.boolean(),
        stateQueryObserved: z.boolean(),
        entityRows: counterSchema,
        stateRows: counterSchema,
      })
      .strict(),
    coverage: z.array(ProjectObservationCoverageV1Schema).min(1).max(256),
    capabilitySet: ProjectCapabilitySetV1Schema,
    cleanup: ProjectRuntimeCleanupReceiptV1Schema,
    outcome: z.enum(["compatible", "incompatible"]),
    failures: z.array(boundedTextSchema).max(256),
    observedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const compatible =
      value.bridgeHandshakeObserved &&
      value.instrumentedLaunchObserved &&
      value.queryObservations.entityQueryObserved &&
      value.queryObservations.stateQueryObserved &&
      value.queryObservations.entityRows > 0 &&
      value.queryObservations.stateRows > 0 &&
      value.coverage.every(
        (entry) =>
          entry.status === "complete" &&
          entry.observedRecords > 0 &&
          entry.droppedRecords === 0 &&
          entry.overwrittenRecords === 0,
      ) &&
      projectRuntimeCleanupCompleteV1(value.cleanup) &&
      value.failures.length === 0;
    if ((value.outcome === "compatible") !== compatible) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message:
          "compatibility outcome must match observed smoke and cleanup facts",
        input: value.outcome,
      });
    }
  });
export type AdapterCompatibilityReceiptV1 = z.infer<
  typeof AdapterCompatibilityReceiptV1Schema
>;

export const ProjectEnvironmentReuseReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    receiptId: ProjectEnvironmentReuseReceiptIdSchema,
    taskId: ProjectEnvironmentTaskIdSchema,
    sessionId: ProjectSessionIdSchema,
    sourceId: SourceIdSchema,
    buildId: BuildIdSchema,
    buildSourceId: SourceIdSchema,
    environmentRevisionId: ProjectEnvironmentRevisionIdSchema,
    adapterRevisionId: ProjectAdapterRevisionIdSchema,
    toolchainReceiptId: ProjectToolchainReceiptIdSchema,
    sdkDigest: Sha256DigestV1Schema,
    bridgeDigest: Sha256DigestV1Schema,
    policyProfileDigest: Sha256DigestV1Schema,
    observedCurrentRevisionId: ProjectEnvironmentRevisionIdSchema,
    compatibilityReceiptId: AdapterCompatibilityReceiptIdSchema,
    schemaBindingValidated: z.boolean(),
    adapterPackageValidated: z.boolean(),
    quickSmokeCompatible: z.boolean(),
    cleanup: ProjectRuntimeCleanupReceiptV1Schema,
    outcome: z.enum(["reused", "rejected"]),
    failures: z.array(boundedTextSchema).max(64),
    observedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const reused =
      value.observedCurrentRevisionId === value.environmentRevisionId &&
      value.schemaBindingValidated &&
      value.adapterPackageValidated &&
      value.quickSmokeCompatible &&
      projectRuntimeCleanupCompleteV1(value.cleanup) &&
      value.failures.length === 0;
    if ((value.outcome === "reused") !== reused) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message:
          "reuse outcome must match exact current, schema, adapter, quick-smoke, and cleanup facts",
        input: value.outcome,
      });
    }
    if (value.outcome === "rejected" && value.failures.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["failures"],
        message: "rejected reuse requires an explicit failure",
        input: value.failures,
      });
    }
  });
export type ProjectEnvironmentReuseReceiptV1 = z.infer<
  typeof ProjectEnvironmentReuseReceiptV1Schema
>;

export const EnvironmentPublicationIntentV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: ProjectEnvironmentOperationIdSchema,
    taskId: ProjectEnvironmentTaskIdSchema,
    attemptId: ProjectInitializationAttemptIdSchema,
    environmentId: ProjectEnvironmentIdSchema,
    candidateId: ProjectAdapterCandidateIdSchema,
    sourceId: SourceIdSchema,
    targetEnvironmentRevisionId: ProjectEnvironmentRevisionIdSchema,
    targetAdapterRevisionId: ProjectAdapterRevisionIdSchema,
    expectedCurrentRevisionId: ProjectEnvironmentRevisionIdSchema.nullable(),
    targetContentDigest: Sha256DigestV1Schema,
    createdAt: timestampSchema,
  })
  .strict();
export type EnvironmentPublicationIntentV1 = z.infer<
  typeof EnvironmentPublicationIntentV1Schema
>;

/**
 * Project-local, path-free authority for reconciling one PE-A publication.
 * The Task intent remains authoritative for Task ownership; this record only
 * makes that exact external intent discoverable after a new command starts.
 */
export const EnvironmentPublicationRecoveryAuthorityV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: ProjectEnvironmentOperationIdSchema,
    taskId: ProjectEnvironmentTaskIdSchema,
    attemptId: ProjectInitializationAttemptIdSchema,
    sessionId: ProjectSessionIdSchema,
    bindingEpochId: EnvironmentBindingEpochIdSchema,
    bindingOrdinal: z.literal(0),
    environmentId: ProjectEnvironmentIdSchema,
    candidateId: ProjectAdapterCandidateIdSchema,
    sourceId: SourceIdSchema,
    targetEnvironmentRevisionId: ProjectEnvironmentRevisionIdSchema,
    targetAdapterRevisionId: ProjectAdapterRevisionIdSchema,
    expectedCurrentRevisionId: z.null(),
    targetContentDigest: Sha256DigestV1Schema,
    pointerCommitRequestedAt: timestampSchema,
    createdAt: timestampSchema,
  })
  .strict();
export type EnvironmentPublicationRecoveryAuthorityV1 = z.infer<
  typeof EnvironmentPublicationRecoveryAuthorityV1Schema
>;

export const EnvironmentPublicationRecoveryResolutionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: ProjectEnvironmentOperationIdSchema,
    taskId: ProjectEnvironmentTaskIdSchema,
    attemptId: ProjectInitializationAttemptIdSchema,
    environmentId: ProjectEnvironmentIdSchema,
    targetEnvironmentRevisionId: ProjectEnvironmentRevisionIdSchema,
    outcome: z.enum(["succeeded", "failed", "binding_failed"]),
    publicationCommitted: z.boolean(),
    publicationReceiptId: EnvironmentPublicationReceiptIdSchema.nullable(),
    bindingEpochId: EnvironmentBindingEpochIdSchema.nullable(),
    failureCode: opaqueTokenSchema.nullable(),
    failureMessage: boundedTextSchema.nullable(),
    resolvedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const succeeded =
      value.publicationCommitted &&
      value.publicationReceiptId !== null &&
      value.bindingEpochId !== null &&
      value.failureCode === null &&
      value.failureMessage === null;
    if ((value.outcome === "succeeded") !== succeeded) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message:
          "succeeded recovery requires committed publication and exact receipt/binding identities",
        input: value.outcome,
      });
    }
    const failed = value.failureCode !== null && value.failureMessage !== null;
    if ((value.outcome !== "succeeded") !== failed) {
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "failed recovery outcomes require a code and message",
        input: value.failureCode,
      });
    }
    if (value.outcome === "failed" && value.publicationCommitted) {
      context.addIssue({
        code: "custom",
        path: ["publicationCommitted"],
        message: "ordinary recovery failure cannot follow pointer commit",
        input: value.publicationCommitted,
      });
    }
    if (
      value.outcome === "binding_failed" &&
      (!value.publicationCommitted || value.bindingEpochId !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message:
          "binding_failed recovery requires a committed publication without a binding epoch",
        input: value.outcome,
      });
    }
  });
export type EnvironmentPublicationRecoveryResolutionV1 = z.infer<
  typeof EnvironmentPublicationRecoveryResolutionV1Schema
>;

export const EnvironmentPublicationReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    receiptId: EnvironmentPublicationReceiptIdSchema,
    operationId: ProjectEnvironmentOperationIdSchema,
    taskId: ProjectEnvironmentTaskIdSchema,
    attemptId: ProjectInitializationAttemptIdSchema,
    environmentId: ProjectEnvironmentIdSchema,
    targetEnvironmentRevisionId: ProjectEnvironmentRevisionIdSchema,
    expectedCurrentRevisionId: ProjectEnvironmentRevisionIdSchema.nullable(),
    observedCurrentRevisionId: ProjectEnvironmentRevisionIdSchema.nullable(),
    realizedCurrentRevisionId: ProjectEnvironmentRevisionIdSchema.nullable(),
    revisionMaterialized: z.boolean(),
    pointerCommitted: z.boolean(),
    outcome: z.enum(["committed", "conflict", "failed"]),
    failures: z.array(boundedTextSchema).max(64),
    completedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const committed =
      value.revisionMaterialized &&
      value.pointerCommitted &&
      value.realizedCurrentRevisionId === value.targetEnvironmentRevisionId &&
      value.failures.length === 0;
    if ((value.outcome === "committed") !== committed) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message:
          "committed publication must match materialization and pointer facts",
        input: value.outcome,
      });
    }
    if (value.outcome !== "committed" && value.failures.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["failures"],
        message: "non-committed publication requires an explicit failure",
        input: value.failures,
      });
    }
    if (value.outcome === "conflict" && value.pointerCommitted) {
      context.addIssue({
        code: "custom",
        path: ["pointerCommitted"],
        message: "a publication conflict cannot commit the target pointer",
        input: value.pointerCommitted,
      });
    }
    if (value.pointerCommitted && value.outcome !== "committed") {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "a committed pointer is always a committed publication",
        input: value.outcome,
      });
    }
    if (
      value.outcome === "conflict" &&
      value.observedCurrentRevisionId === value.expectedCurrentRevisionId
    ) {
      context.addIssue({
        code: "custom",
        path: ["observedCurrentRevisionId"],
        message:
          "a compare-and-swap conflict requires a mismatched current revision",
        input: value.observedCurrentRevisionId,
      });
    }
  });
export type EnvironmentPublicationReceiptV1 = z.infer<
  typeof EnvironmentPublicationReceiptV1Schema
>;

export const ProjectInitializationAttemptStateV1Schema = z.enum([
  "created",
  "agent_running",
  "candidate_frozen",
  "validating",
  "publishing",
  "publication_committed",
  "binding",
  "reconciling",
  "succeeded",
  "failed",
  "cancelled",
  "binding_failed",
]);
export type ProjectInitializationAttemptStateV1 = z.infer<
  typeof ProjectInitializationAttemptStateV1Schema
>;

const attemptEventIdentityShape = {
  schemaVersion: z.literal(1),
  eventId: ProjectInitializationAttemptEventIdSchema,
  attemptId: ProjectInitializationAttemptIdSchema,
  taskId: ProjectEnvironmentTaskIdSchema,
  sequence: counterSchema,
  occurredAt: timestampSchema,
};

const attemptEvent = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.object({ ...attemptEventIdentityShape, ...shape }).strict();

export const ProjectInitializationAttemptEventV1Schema = z.discriminatedUnion(
  "eventKind",
  [
    attemptEvent({
      eventKind: z.literal("created"),
      predecessorAttemptId: ProjectInitializationAttemptIdSchema.nullable(),
      sessionId: ProjectSessionIdSchema,
      sourceId: SourceIdSchema,
      providerId: opaqueTokenSchema,
      modelId: opaqueTokenSchema,
      thinkingLevel: opaqueTokenSchema,
      budget: ProjectTurnBudgetV1Schema,
    }),
    attemptEvent({ eventKind: z.literal("agent_running") }),
    attemptEvent({
      eventKind: z.literal("candidate_frozen"),
      candidate: ProjectAdapterCandidateReferenceV1Schema,
    }),
    attemptEvent({ eventKind: z.literal("validating") }),
    attemptEvent({
      eventKind: z.literal("publishing"),
      operationId: ProjectEnvironmentOperationIdSchema,
    }),
    attemptEvent({
      eventKind: z.literal("publication_committed"),
      operationId: ProjectEnvironmentOperationIdSchema,
      environmentRevisionId: ProjectEnvironmentRevisionIdSchema,
      adapterRevisionId: ProjectAdapterRevisionIdSchema,
      publicationReceiptId: EnvironmentPublicationReceiptIdSchema,
    }),
    attemptEvent({ eventKind: z.literal("binding") }),
    attemptEvent({
      eventKind: z.literal("reconciling"),
      operationId: ProjectEnvironmentOperationIdSchema.nullable(),
    }),
    attemptEvent({
      eventKind: z.literal("succeeded"),
      bindingEpochId: EnvironmentBindingEpochIdSchema,
    }),
    attemptEvent({
      eventKind: z.literal("failed"),
      failureCode: opaqueTokenSchema,
      message: boundedTextSchema,
    }),
    attemptEvent({
      eventKind: z.literal("cancelled"),
      reason: boundedTextSchema,
    }),
    attemptEvent({
      eventKind: z.literal("binding_failed"),
      failureCode: opaqueTokenSchema,
      message: boundedTextSchema,
    }),
  ],
);
export type ProjectInitializationAttemptEventV1 = z.infer<
  typeof ProjectInitializationAttemptEventV1Schema
>;

export const ProjectInitializationAttemptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    attemptId: ProjectInitializationAttemptIdSchema,
    predecessorAttemptId: ProjectInitializationAttemptIdSchema.nullable(),
    taskId: ProjectEnvironmentTaskIdSchema,
    sessionId: ProjectSessionIdSchema,
    sourceId: SourceIdSchema,
    providerId: opaqueTokenSchema,
    modelId: opaqueTokenSchema,
    thinkingLevel: opaqueTokenSchema,
    budget: ProjectTurnBudgetV1Schema,
    state: ProjectInitializationAttemptStateV1Schema,
    candidateId: ProjectAdapterCandidateIdSchema.nullable(),
    candidateDigest: Sha256DigestV1Schema.nullable(),
    publicationOperationId: ProjectEnvironmentOperationIdSchema.nullable(),
    environmentRevisionId: ProjectEnvironmentRevisionIdSchema.nullable(),
    adapterRevisionId: ProjectAdapterRevisionIdSchema.nullable(),
    publicationReceiptId: EnvironmentPublicationReceiptIdSchema.nullable(),
    bindingEpochId: EnvironmentBindingEpochIdSchema.nullable(),
    terminalCode: opaqueTokenSchema.nullable(),
    terminalMessage: boundedTextSchema.nullable(),
    eventCount: positiveCounterSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    sealedAt: timestampSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const terminal = [
      "succeeded",
      "failed",
      "cancelled",
      "binding_failed",
    ].includes(value.state);
    if (terminal !== (value.sealedAt !== null)) {
      context.addIssue({
        code: "custom",
        path: ["sealedAt"],
        message:
          "terminal attempts are sealed and nonterminal attempts are not",
        input: value.sealedAt,
      });
    }
    if ((value.candidateId === null) !== (value.candidateDigest === null)) {
      context.addIssue({
        code: "custom",
        path: ["candidateDigest"],
        message: "candidate identity and digest must appear together",
        input: value.candidateDigest,
      });
    }
    if (
      value.predecessorAttemptId !== null &&
      value.predecessorAttemptId === value.attemptId
    ) {
      context.addIssue({
        code: "custom",
        path: ["predecessorAttemptId"],
        message: "an attempt cannot be its own predecessor",
        input: value.predecessorAttemptId,
      });
    }
    const candidateRequired = [
      "candidate_frozen",
      "validating",
      "publishing",
      "publication_committed",
      "binding",
      "succeeded",
      "binding_failed",
    ].includes(value.state);
    if (candidateRequired && value.candidateId === null) {
      context.addIssue({
        code: "custom",
        path: ["candidateId"],
        message: "this attempt state requires a frozen candidate identity",
        input: value.candidateId,
      });
    }
    if (value.state === "publishing" && value.publicationOperationId === null) {
      context.addIssue({
        code: "custom",
        path: ["publicationOperationId"],
        message: "publishing requires its durable operation identity",
        input: value.publicationOperationId,
      });
    }
    const publicationRequired = [
      "publication_committed",
      "binding",
      "succeeded",
      "binding_failed",
    ].includes(value.state);
    if (
      publicationRequired &&
      (value.environmentRevisionId === null ||
        value.adapterRevisionId === null ||
        value.publicationReceiptId === null ||
        value.publicationOperationId === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["environmentRevisionId"],
        message:
          "post-publication terminal states require exact publication identities",
        input: value.environmentRevisionId,
      });
    }
    if ((value.state === "succeeded") !== (value.bindingEpochId !== null)) {
      context.addIssue({
        code: "custom",
        path: ["bindingEpochId"],
        message: "only succeeded attempts carry a completed binding epoch",
        input: value.bindingEpochId,
      });
    }
    if (
      ["failed", "cancelled", "binding_failed"].includes(value.state) !==
      (value.terminalCode !== null && value.terminalMessage !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["terminalCode"],
        message: "failure terminals require a code and message",
        input: value.terminalCode,
      });
    }
    if (
      ["failed", "cancelled"].includes(value.state) &&
      value.publicationReceiptId !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message:
          "an attempt cannot report ordinary failure after publication commit",
        input: value.state,
      });
    }
    if (value.state === "cancelled" && value.terminalCode !== "cancelled") {
      context.addIssue({
        code: "custom",
        path: ["terminalCode"],
        message: "cancelled attempts use the canonical cancelled terminal code",
        input: value.terminalCode,
      });
    }
  });
export type ProjectInitializationAttemptV1 = z.infer<
  typeof ProjectInitializationAttemptV1Schema
>;

const allowedAttemptTransitions: Readonly<
  Record<
    ProjectInitializationAttemptStateV1,
    readonly ProjectInitializationAttemptStateV1[]
  >
> = {
  created: ["agent_running", "reconciling", "failed", "cancelled"],
  agent_running: ["candidate_frozen", "reconciling", "failed", "cancelled"],
  candidate_frozen: ["validating", "reconciling", "failed", "cancelled"],
  validating: ["publishing", "reconciling", "failed", "cancelled"],
  publishing: ["publication_committed", "reconciling", "failed", "cancelled"],
  publication_committed: ["binding", "reconciling"],
  binding: ["succeeded", "binding_failed", "reconciling"],
  reconciling: [
    "publishing",
    "publication_committed",
    "binding",
    "failed",
    "binding_failed",
  ],
  succeeded: [],
  failed: [],
  cancelled: [],
  binding_failed: [],
};

const stateForAttemptEvent = (
  event: ProjectInitializationAttemptEventV1,
): ProjectInitializationAttemptStateV1 => event.eventKind;

export const foldProjectInitializationAttemptV1 = (
  untrustedEvents: readonly unknown[],
): ProjectInitializationAttemptV1 => {
  if (untrustedEvents.length === 0) {
    throw new Error("Project initialization attempt requires a created event");
  }
  const events = untrustedEvents.map((event) =>
    ProjectInitializationAttemptEventV1Schema.parse(event),
  );
  const created = events[0];
  if (created === undefined || created.eventKind !== "created") {
    throw new Error("Project initialization attempt must begin with created");
  }
  let state: ProjectInitializationAttemptStateV1 = "created";
  let candidateId: ProjectAdapterCandidateId | null = null;
  let candidateDigest: z.infer<typeof Sha256DigestV1Schema> | null = null;
  let publicationOperationId: ProjectEnvironmentOperationId | null = null;
  let environmentRevisionId: ProjectEnvironmentRevisionId | null = null;
  let adapterRevisionId: ProjectAdapterRevisionId | null = null;
  let publicationReceiptId: EnvironmentPublicationReceiptId | null = null;
  let bindingEpochId: EnvironmentBindingEpochId | null = null;
  let terminalCode: string | null = null;
  let terminalMessage: string | null = null;
  let previousTime = Date.parse(created.occurredAt);
  const eventIds = new Set<ProjectInitializationAttemptEventId>();

  for (const [index, event] of events.entries()) {
    if (event.sequence !== index) {
      throw new Error(
        "Project initialization attempt event sequence must be contiguous",
      );
    }
    if (eventIds.has(event.eventId)) {
      throw new Error(
        "Project initialization attempt event IDs must be unique",
      );
    }
    eventIds.add(event.eventId);
    if (
      event.attemptId !== created.attemptId ||
      event.taskId !== created.taskId
    ) {
      throw new Error(
        "Project initialization attempt events cannot cross ownership",
      );
    }
    const time = Date.parse(event.occurredAt);
    if (time < previousTime) {
      throw new Error(
        "Project initialization attempt event time cannot move backwards",
      );
    }
    previousTime = time;
    if (index === 0) {
      continue;
    }
    const nextState = stateForAttemptEvent(event);
    if (!allowedAttemptTransitions[state].includes(nextState)) {
      throw new Error(
        `Invalid project initialization transition: ${state} -> ${nextState}`,
      );
    }
    if (
      (event.eventKind === "failed" || event.eventKind === "cancelled") &&
      publicationReceiptId !== null
    ) {
      throw new Error(
        "A committed publication can terminate only after binding or as binding_failed",
      );
    }
    if (
      [
        "publishing",
        "publication_committed",
        "binding",
        "succeeded",
        "binding_failed",
      ].includes(event.eventKind) &&
      candidateId === null
    ) {
      throw new Error(
        "Publication and binding events require a frozen adapter candidate",
      );
    }
    if (
      ["binding", "succeeded", "binding_failed"].includes(event.eventKind) &&
      publicationReceiptId === null
    ) {
      throw new Error(
        "Binding events require an authoritative publication commit",
      );
    }
    state = nextState;
    switch (event.eventKind) {
      case "candidate_frozen":
        if (
          event.candidate.taskId !== created.taskId ||
          event.candidate.attemptId !== created.attemptId ||
          event.candidate.sourceId !== created.sourceId
        ) {
          throw new Error(
            "Frozen adapter candidate does not belong to this attempt",
          );
        }
        candidateId = event.candidate.candidateId;
        candidateDigest = event.candidate.contentDigest;
        break;
      case "publishing":
        publicationOperationId = event.operationId;
        break;
      case "publication_committed":
        if (
          publicationOperationId !== null &&
          publicationOperationId !== event.operationId
        ) {
          throw new Error(
            "Publication commit operation differs from its intent",
          );
        }
        publicationOperationId = event.operationId;
        environmentRevisionId = event.environmentRevisionId;
        adapterRevisionId = event.adapterRevisionId;
        publicationReceiptId = event.publicationReceiptId;
        break;
      case "succeeded":
        bindingEpochId = event.bindingEpochId;
        break;
      case "failed":
        terminalCode = event.failureCode;
        terminalMessage = event.message;
        break;
      case "cancelled":
        terminalCode = "cancelled";
        terminalMessage = event.reason;
        break;
      case "binding_failed":
        terminalCode = event.failureCode;
        terminalMessage = event.message;
        break;
      case "created":
      case "agent_running":
      case "validating":
      case "binding":
      case "reconciling":
        break;
    }
  }

  const last = events.at(-1);
  if (last === undefined) {
    throw new Error("Project initialization attempt has no last event");
  }
  const sealed = [
    "succeeded",
    "failed",
    "cancelled",
    "binding_failed",
  ].includes(state);
  return ProjectInitializationAttemptV1Schema.parse({
    schemaVersion: 1,
    attemptId: created.attemptId,
    predecessorAttemptId: created.predecessorAttemptId,
    taskId: created.taskId,
    sessionId: created.sessionId,
    sourceId: created.sourceId,
    providerId: created.providerId,
    modelId: created.modelId,
    thinkingLevel: created.thinkingLevel,
    budget: created.budget,
    state,
    candidateId,
    candidateDigest,
    publicationOperationId,
    environmentRevisionId,
    adapterRevisionId,
    publicationReceiptId,
    bindingEpochId,
    terminalCode,
    terminalMessage,
    eventCount: events.length,
    createdAt: created.occurredAt,
    updatedAt: last.occurredAt,
    sealedAt: sealed ? last.occurredAt : null,
  });
};

export const EnvironmentBindingEpochV1Schema = z.discriminatedUnion("state", [
  z
    .object({
      schemaVersion: z.literal(1),
      bindingEpochId: EnvironmentBindingEpochIdSchema,
      taskId: ProjectEnvironmentTaskIdSchema,
      ordinal: counterSchema,
      state: z.literal("pending"),
      attemptId: ProjectInitializationAttemptIdSchema,
      createdAt: timestampSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      bindingEpochId: EnvironmentBindingEpochIdSchema,
      taskId: ProjectEnvironmentTaskIdSchema,
      ordinal: counterSchema,
      state: z.literal("bound"),
      attemptId: ProjectInitializationAttemptIdSchema,
      environment: ProjectEnvironmentRevisionReferenceV1Schema,
      publicationOperationId: ProjectEnvironmentOperationIdSchema,
      publicationReceiptId: EnvironmentPublicationReceiptIdSchema,
      createdAt: timestampSchema,
      boundAt: timestampSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      bindingEpochId: EnvironmentBindingEpochIdSchema,
      taskId: ProjectEnvironmentTaskIdSchema,
      ordinal: counterSchema,
      state: z.literal("reused"),
      sessionId: ProjectSessionIdSchema,
      environment: ProjectEnvironmentRevisionReferenceV1Schema,
      reuseReceiptId: ProjectEnvironmentReuseReceiptIdSchema,
      compatibilityReceiptId: AdapterCompatibilityReceiptIdSchema,
      createdAt: timestampSchema,
      boundAt: timestampSchema,
    })
    .strict(),
]);
export type EnvironmentBindingEpochV1 = z.infer<
  typeof EnvironmentBindingEpochV1Schema
>;

export const ProjectEnvironmentTurnV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    turnId: ProjectEnvironmentTurnIdSchema,
    taskId: ProjectEnvironmentTaskIdSchema,
    sessionId: ProjectSessionIdSchema,
    purpose: z.enum([
      "environment_initialization",
      "environment_maintenance",
      "user_goal",
    ]),
    attemptId: ProjectInitializationAttemptIdSchema.nullable(),
    bindingEpochId: EnvironmentBindingEpochIdSchema.nullable(),
    promptDigest: Sha256DigestV1Schema,
    queuedGoalDigest: Sha256DigestV1Schema.nullable(),
    budget: ProjectTurnBudgetV1Schema,
    usageStatus: z.enum(["observed", "partial", "unavailable"]),
    usage: ProjectTurnUsageV1Schema.nullable(),
    status: z.enum(["created", "running", "completed", "failed", "cancelled"]),
    terminalCode: opaqueTokenSchema.nullable(),
    terminalMessage: boundedTextSchema.nullable(),
    startedAt: timestampSchema.nullable(),
    endedAt: timestampSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.purpose === "user_goal") !== (value.attemptId === null)) {
      context.addIssue({
        code: "custom",
        path: ["attemptId"],
        message: "environment turns bind an attempt; user-goal turns do not",
        input: value.attemptId,
      });
    }
    if (value.purpose === "user_goal" && value.bindingEpochId === null) {
      context.addIssue({
        code: "custom",
        path: ["bindingEpochId"],
        message: "a user goal cannot start before an exact environment binding",
        input: value.bindingEpochId,
      });
    }
    if (
      value.purpose !== "environment_initialization" &&
      value.queuedGoalDigest !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["queuedGoalDigest"],
        message: "only initialization may retain a separately queued user goal",
        input: value.queuedGoalDigest,
      });
    }
    if ((value.usageStatus === "unavailable") !== (value.usage === null)) {
      context.addIssue({
        code: "custom",
        path: ["usageStatus"],
        message:
          "available turn usage requires observed counters and unavailable usage must remain null",
        input: value.usageStatus,
      });
    }
    if (value.usage !== null) {
      const observedCounters = [
        value.usage.wallTimeMs,
        value.usage.toolCalls,
        value.usage.runtimeTimeMs,
        value.usage.inputTokens,
        value.usage.outputTokens,
        value.usage.storageBytes,
        value.usage.storageInodes,
      ];
      const allObserved = observedCounters.every(
        (observed) => observed !== null,
      );
      if (
        (value.usageStatus === "observed" && !allObserved) ||
        (value.usageStatus === "partial" && allObserved)
      ) {
        context.addIssue({
          code: "custom",
          path: ["usageStatus"],
          message:
            "usageStatus must distinguish complete observed counters from partial counters",
          input: value.usageStatus,
        });
      }
    }
    const terminalFailure = ["failed", "cancelled"].includes(value.status);
    if ((value.terminalCode === null) !== (value.terminalMessage === null)) {
      context.addIssue({
        code: "custom",
        path: ["terminalMessage"],
        message: "turn terminal code and message must appear together",
        input: value.terminalMessage,
      });
    }
    if (terminalFailure !== (value.terminalCode !== null)) {
      context.addIssue({
        code: "custom",
        path: ["terminalCode"],
        message:
          "failed and cancelled turns require a terminal code and message",
        input: value.terminalCode,
      });
    }
    const started = value.status !== "created";
    const ended = ["completed", "failed", "cancelled"].includes(value.status);
    if (
      started !== (value.startedAt !== null) ||
      ended !== (value.endedAt !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "turn timestamps must match its lifecycle state",
        input: value.status,
      });
    }
    if (
      value.startedAt !== null &&
      value.endedAt !== null &&
      Date.parse(value.endedAt) < Date.parse(value.startedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["endedAt"],
        message: "turn end time cannot precede its start time",
        input: value.endedAt,
      });
    }
  });
export type ProjectEnvironmentTurnV1 = z.infer<
  typeof ProjectEnvironmentTurnV1Schema
>;

export const ProjectEnvironmentBuildBindingV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: ProjectEnvironmentTaskIdSchema,
    workspaceId: WorkspaceIdSchema,
    sourceId: SourceIdSchema,
    buildId: BuildIdSchema,
    bindingEpochId: EnvironmentBindingEpochIdSchema,
    environmentRevisionId: ProjectEnvironmentRevisionIdSchema,
    adapterRevisionId: ProjectAdapterRevisionIdSchema,
    payloadSchemaDigest: Sha256DigestV1Schema,
    sdkDigest: Sha256DigestV1Schema,
    bridgeDigest: Sha256DigestV1Schema,
    toolchainReceiptId: ProjectToolchainReceiptIdSchema,
    compatibilityStatus: z.enum(["pending", "compatible", "incompatible"]),
    compatibilityReceiptId: AdapterCompatibilityReceiptIdSchema.nullable(),
    createdAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.compatibilityStatus === "pending") !==
      (value.compatibilityReceiptId === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["compatibilityReceiptId"],
        message: "completed compatibility states require their exact receipt",
        input: value.compatibilityReceiptId,
      });
    }
  });
export type ProjectEnvironmentBuildBindingV1 = z.infer<
  typeof ProjectEnvironmentBuildBindingV1Schema
>;
