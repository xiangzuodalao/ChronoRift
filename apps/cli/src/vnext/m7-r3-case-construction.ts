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
  ExecutionIdSchema,
  JsonValueSchema,
  M6AdapterBuildCompatibilityReceiptV1Schema,
  ProjectAdapterRevisionV1Schema,
  RuntimeIdSchema,
  Sha256DigestV1Schema,
  SourceIdSchema,
  TaskIdSchema,
  VNextBuildV1Schema,
  asSha256DigestV1,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { z } from "zod";

import {
  M7HiddenMutationRegistrationV1Schema,
  M7PatrolPreflightResultV1Schema,
  M7SensorFreezeRecordV1Schema,
  M7_PATROL_SCENARIO_PLAN_V1,
  type M7PatrolStateTimelineV1,
} from "./m7-patrol-sensor.js";
import {
  M7PatrolTrajectoryClassifierConfigV1Schema,
  M7PatrolTrajectoryWitnessKindV1Schema,
  M7R3PatrolTrajectoryCaseSpecV1Schema,
  M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1,
  M7_PATROL_TRAJECTORY_CLASSIFIER_ID_V1,
  M7_PATROL_TRAJECTORY_WITNESS_KINDS_V1,
  classifyM7PatrolTrajectoryV1,
} from "./m7-patrol-trajectory.js";
import {
  M7R3TwoCasePortfolioFreezeV1Schema,
  type M7R3TwoCasePortfolioFreezeV1,
} from "./m7-r3-two-case-portfolio.js";
import { deriveM7BuildSourceIdentitySha256V1 } from "./m7-runtime-use-campaign.js";
import { publishPrivateFileOnceV1 } from "./private-atomic-publication.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const RECORD_BYTE_LIMIT = 4 * 1024 * 1024;
const MATERIAL_BYTE_LIMIT = 64 * 1024 * 1024;

const timestampSchema = z.string().datetime({ offset: true });
const caseOrdinalSchema = z.union([z.literal(1), z.literal(2)]);
const positiveSafeIntegerSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);
const nonnegativeSafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const classifierFreezeIdSchema = z
  .string()
  .regex(/^m7-r3-trajectory-classifier-freeze:[a-f0-9]{24}$/u);
const constructionIdSchema = z
  .string()
  .regex(/^m7-r3-case-construction:[a-f0-9]{24}$/u);
const preflightIdSchema = z
  .string()
  .regex(/^m7-r3-case-preflight:[a-f0-9]{24}$/u);
const portfolioCaseIdSchema = z.string().regex(/^m7-r3-case:[a-f0-9]{24}$/u);
const gitRevisionSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const mainSceneSchema = z
  .string()
  .min(7)
  .max(2_048)
  .regex(/^res:\/\/[A-Za-z0-9_./ -]+\.(?:tscn|scn)$/u)
  .refine((value) => !value.includes(".."), {
    message: "configured main scene cannot traverse paths",
  });

const digest = (bytes: string | Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

const digestJson = (value: unknown): Sha256DigestV1 =>
  digest(canonicalJson(JsonValueSchema.parse(value)));

const sameJson = (left: unknown, right: unknown): boolean =>
  canonicalJson(JsonValueSchema.parse(left)) ===
  canonicalJson(JsonValueSchema.parse(right));

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

const materialBytes = (
  value: string | Uint8Array,
  label: string,
  maximum = MATERIAL_BYTE_LIMIT,
): Uint8Array => {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  if (bytes.byteLength < 1 || bytes.byteLength > maximum) {
    throw new TypeError(`${label} must contain between 1 byte and ${maximum}`);
  }
  return bytes;
};

const requireNeutralClassifierBytes = (
  value: string | Uint8Array,
): Uint8Array => {
  const bytes = materialBytes(
    value,
    "M7 R3 generic trajectory classifier",
    4 * 1024 * 1024,
  );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new TypeError(
      "M7 R3 generic trajectory classifier must be valid UTF-8",
      { cause: error },
    );
  }
  if (
    /(?:storyvore|ray[ _.-]*cast|left[ _.-]*ray|right[ _.-]*ray|collision[ _.-]*mask|source[ _.-]*(?:path|locus)|node[ _.-]*path|\bmutation\b|\bfix(?:es|ed|ing)?\b)/iu.test(
      text,
    )
  ) {
    throw new TypeError(
      "M7 R3 trajectory classifier contains Bug-specific or source-specific vocabulary",
    );
  }
  return bytes;
};

const pristineSubjectSchema = z
  .object({
    repository: z.string().url().max(2_048),
    revision: gitRevisionSchema,
    sourceId: SourceIdSchema,
    subjectProjectSha256: Sha256DigestV1Schema,
    selectedTreeSha256: Sha256DigestV1Schema,
  })
  .strict();

const authoritativeAdapterSchema = z
  .object({
    adapterRevisionId: ProjectAdapterRevisionV1Schema.shape.adapterRevisionId,
    adapterRevisionRecordSha256: Sha256DigestV1Schema,
    adapterId: ProjectAdapterRevisionV1Schema.shape.adapterId,
    pristineSourceId: SourceIdSchema,
    packageSha256: Sha256DigestV1Schema,
    manifestSha256: Sha256DigestV1Schema,
    implementationSha256: Sha256DigestV1Schema,
    observationSchemaSha256: Sha256DigestV1Schema,
    sdkSha256: Sha256DigestV1Schema,
    bridgeSha256: Sha256DigestV1Schema,
    pristineConformanceReceiptId:
      ProjectAdapterRevisionV1Schema.shape.conformanceReceiptId,
    pristineConformanceReceiptSha256: Sha256DigestV1Schema,
  })
  .strict();

const classifierFreezeBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-trajectory-classifier-freeze"),
    frozenBeforeMutation: z.literal(true),
    authoritativeSensorFreezeId:
      M7SensorFreezeRecordV1Schema.shape.sensorFreezeId,
    authoritativeSensorFreezeRecordSha256: Sha256DigestV1Schema,
    pristineSubject: pristineSubjectSchema,
    authoritativeAdapter: authoritativeAdapterSchema,
    observationSchemaId:
      M7SensorFreezeRecordV1Schema.shape.sensor.shape.observationSchemaId,
    classifierId: z.literal(M7_PATROL_TRAJECTORY_CLASSIFIER_ID_V1),
    classifierImplementationByteLength: positiveSafeIntegerSchema.max(
      4 * 1024 * 1024,
    ),
    classifierImplementationSha256: Sha256DigestV1Schema,
    classifierConfig: M7PatrolTrajectoryClassifierConfigV1Schema,
    frozenAt: timestampSchema,
  })
  .strict();

export const M7R3TrajectoryClassifierFreezeV1Schema =
  classifierFreezeBasisSchema
    .extend({
      classifierFreezeId: classifierFreezeIdSchema,
      recordContentSha256: Sha256DigestV1Schema,
    })
    .strict()
    .superRefine((value, context) => {
      const { classifierFreezeId, recordContentSha256, ...basis } = value;
      const expectedHash = digestJson(basis);
      if (
        classifierFreezeId !==
        `m7-r3-trajectory-classifier-freeze:${expectedHash.slice(0, 24)}`
      ) {
        addIssue(
          context,
          ["classifierFreezeId"],
          "trajectory classifier freeze ID does not derive from its content",
        );
      }
      if (recordContentSha256 !== expectedHash) {
        addIssue(
          context,
          ["recordContentSha256"],
          "trajectory classifier freeze content hash does not match",
        );
      }
    });
export type M7R3TrajectoryClassifierFreezeV1 = z.infer<
  typeof M7R3TrajectoryClassifierFreezeV1Schema
>;

export interface CreateM7R3TrajectoryClassifierFreezeV1Input {
  readonly authoritativeSensorFreeze: unknown;
  readonly authoritativeAdapterRevision: unknown;
  readonly classifierImplementationBytes: string | Uint8Array;
  readonly classifierConfig?: unknown;
  readonly frozenAt: string;
}

/**
 * Freezes only the mutation-neutral trajectory classifier and the already
 * authoritative public sensor/Adapter identities. The implementation bytes
 * are hashed and discarded; they are never part of the persisted DTO.
 */
export const createM7R3TrajectoryClassifierFreezeV1 = (
  input: CreateM7R3TrajectoryClassifierFreezeV1Input,
): M7R3TrajectoryClassifierFreezeV1 => {
  const sensor = M7SensorFreezeRecordV1Schema.parse(
    input.authoritativeSensorFreeze,
  );
  const adapter = ProjectAdapterRevisionV1Schema.parse(
    input.authoritativeAdapterRevision,
  );
  if (
    adapter.adapterRevisionId !== sensor.sensor.adapterRevisionId ||
    adapter.sourceId !== sensor.pristineSubject.sourceId ||
    adapter.conformanceReceiptId !== sensor.sensor.pristineConformanceReceiptId
  ) {
    throw new TypeError(
      "M7 R3 classifier freeze crossed the authoritative sensor/Adapter identity",
    );
  }
  const classifierBytes = requireNeutralClassifierBytes(
    input.classifierImplementationBytes,
  );
  const classifierConfig = M7PatrolTrajectoryClassifierConfigV1Schema.parse(
    input.classifierConfig ?? M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1,
  );
  const frozenAt = timestampSchema.parse(input.frozenAt);
  if (Date.parse(frozenAt) < Date.parse(sensor.frozenAt)) {
    throw new TypeError(
      "M7 R3 trajectory classifier cannot be frozen before its authoritative sensor",
    );
  }
  const basis = classifierFreezeBasisSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-r3-trajectory-classifier-freeze",
    frozenBeforeMutation: true,
    authoritativeSensorFreezeId: sensor.sensorFreezeId,
    authoritativeSensorFreezeRecordSha256: sensor.recordSha256,
    pristineSubject: sensor.pristineSubject,
    authoritativeAdapter: {
      adapterRevisionId: adapter.adapterRevisionId,
      adapterRevisionRecordSha256: digestJson(adapter),
      adapterId: adapter.adapterId,
      pristineSourceId: adapter.sourceId,
      packageSha256: adapter.packageDigest,
      manifestSha256: adapter.manifestDigest,
      implementationSha256: adapter.implementationDigest,
      observationSchemaSha256: adapter.payloadSchemaDigest,
      sdkSha256: adapter.sdkDigest,
      bridgeSha256: adapter.bridgeDigest,
      pristineConformanceReceiptId: adapter.conformanceReceiptId,
      pristineConformanceReceiptSha256:
        sensor.sensor.pristineConformanceReceiptSha256,
    },
    observationSchemaId: sensor.sensor.observationSchemaId,
    classifierId: M7_PATROL_TRAJECTORY_CLASSIFIER_ID_V1,
    classifierImplementationByteLength: classifierBytes.byteLength,
    classifierImplementationSha256: digest(classifierBytes),
    classifierConfig,
    frozenAt,
  });
  const recordContentSha256 = digestJson(basis);
  return deepFreeze(
    M7R3TrajectoryClassifierFreezeV1Schema.parse({
      ...basis,
      classifierFreezeId: `m7-r3-trajectory-classifier-freeze:${recordContentSha256.slice(0, 24)}`,
      recordContentSha256,
    }),
  );
};

const sourceIdentitySchema = z
  .object({
    buildId: VNextBuildV1Schema.shape.buildId,
    buildRecordSha256: Sha256DigestV1Schema,
    buildCreatedAt: timestampSchema,
    sourceId: SourceIdSchema,
    sourceSha256: Sha256DigestV1Schema,
    selectedTreeSha256: Sha256DigestV1Schema,
    sourceIdentitySha256: Sha256DigestV1Schema,
  })
  .strict();

const promptIdentitySchema = z
  .object({
    utf8ByteLength: positiveSafeIntegerSchema.max(64 * 1024),
    utf8Sha256: Sha256DigestV1Schema,
    canonicalJsonSha256: Sha256DigestV1Schema,
  })
  .strict();

const materialIdentitySchema = z
  .object({
    byteLength: positiveSafeIntegerSchema.max(MATERIAL_BYTE_LIMIT),
    sha256: Sha256DigestV1Schema,
  })
  .strict();

const mutationIdentitySchema = z
  .object({
    mutationRegistrationId:
      M7HiddenMutationRegistrationV1Schema.shape.mutationRegistrationId,
    mutationRegistrationRecordSha256: Sha256DigestV1Schema,
    sensorFreezeId: M7SensorFreezeRecordV1Schema.shape.sensorFreezeId,
    mutationSha256: Sha256DigestV1Schema,
    mutationByteLength: positiveSafeIntegerSchema.max(4 * 1024 * 1024),
    mutatedSourceId: SourceIdSchema,
    mutatedSelectedTreeSha256: Sha256DigestV1Schema,
    registeredAt: timestampSchema,
  })
  .strict();

const compatibilityIdentitySchema = z
  .object({
    receiptId: M6AdapterBuildCompatibilityReceiptV1Schema.shape.receiptId,
    receiptRecordSha256: Sha256DigestV1Schema,
    outcome: z.enum(["compatible", "incompatible"]),
    buildRole: z.enum(["assignment_baseline", "candidate"]),
    baselineSourceHash: Sha256DigestV1Schema,
    buildId: VNextBuildV1Schema.shape.buildId,
    buildSourceId: SourceIdSchema,
    buildSourceSha256: Sha256DigestV1Schema,
    adapterRevisionId: ProjectAdapterRevisionV1Schema.shape.adapterRevisionId,
    adapterPristineSourceId: SourceIdSchema,
    adapterPackageSha256: Sha256DigestV1Schema,
    adapterObservationSchemaSha256: Sha256DigestV1Schema,
    cleanupProven: z.boolean(),
    observedAt: timestampSchema,
  })
  .strict();

const cleanupProofSchema = z
  .object({
    proven: z.boolean(),
    receiptSha256: Sha256DigestV1Schema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.proven !== (value.receiptSha256 !== null)) {
      addIssue(
        context,
        ["receiptSha256"],
        "cleanup proof requires exactly one receipt hash",
      );
    }
  });

export const M7R3CaseConstructionFailureReasonV1Schema = z.enum([
  "classifier_not_frozen_before_mutation",
  "mutation_crossed_authoritative_sensor",
  "mutant_source_identity_invalid",
  "trajectory_case_spec_mismatch",
  "adapter_compatibility_not_compatible",
  "adapter_compatibility_crossed_mutant_build",
  "adapter_compatibility_crossed_pristine_adapter",
  "construction_cleanup_not_proven",
]);
export type M7R3CaseConstructionFailureReasonV1 = z.infer<
  typeof M7R3CaseConstructionFailureReasonV1Schema
>;

const constructionBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-case-construction"),
    ordinal: caseOrdinalSchema,
    trajectoryClassifierFreezeId: classifierFreezeIdSchema,
    trajectoryClassifierFreezeRecordSha256: Sha256DigestV1Schema,
    authoritativeSensorFreezeId:
      M7SensorFreezeRecordV1Schema.shape.sensorFreezeId,
    authoritativeSensorFreezeRecordSha256: Sha256DigestV1Schema,
    authoritativeAdapterRevisionRecordSha256: Sha256DigestV1Schema,
    authoritativeAdapter: authoritativeAdapterSchema,
    classifierImplementationSha256: Sha256DigestV1Schema,
    classifierConfigSha256: Sha256DigestV1Schema,
    classifierFrozenAt: timestampSchema,
    pristineSubject: pristineSubjectSchema,
    mutation: mutationIdentitySchema,
    mutatedBuild: sourceIdentitySchema,
    naturalPrompt: promptIdentitySchema,
    trajectoryCaseSpec: M7R3PatrolTrajectoryCaseSpecV1Schema,
    adapterMutantCompatibility: compatibilityIdentitySchema,
    pairedPublicTaskContract: materialIdentitySchema,
    preflightImplementation: materialIdentitySchema,
    evaluatorImplementation: materialIdentitySchema,
    evaluatorBundle: materialIdentitySchema,
    cleanup: cleanupProofSchema,
    outcome: z.enum(["passed", "construction_failed"]),
    failureReasons: z.array(M7R3CaseConstructionFailureReasonV1Schema).max(8),
    constructedAt: timestampSchema,
  })
  .strict();

type ConstructionBasis = z.infer<typeof constructionBasisSchema>;

const deriveConstructionFailureReasons = (
  value: ConstructionBasis,
): readonly M7R3CaseConstructionFailureReasonV1[] => {
  const reasons: M7R3CaseConstructionFailureReasonV1[] = [];
  if (
    Date.parse(value.mutation.registeredAt) <
    Date.parse(value.classifierFrozenAt)
  ) {
    reasons.push("classifier_not_frozen_before_mutation");
  }
  if (
    value.mutation.sensorFreezeId !== value.authoritativeSensorFreezeId ||
    value.mutation.mutatedSourceId === value.pristineSubject.sourceId ||
    value.mutation.mutatedSelectedTreeSha256 ===
      value.pristineSubject.selectedTreeSha256
  ) {
    reasons.push("mutation_crossed_authoritative_sensor");
  }
  const expectedSourceIdentity = deriveM7BuildSourceIdentitySha256V1({
    sourceId: value.mutatedBuild.sourceId,
    sourceHash: value.mutatedBuild.sourceSha256,
  });
  if (
    value.mutation.mutatedSourceId !== value.mutatedBuild.sourceId ||
    value.mutation.mutatedSelectedTreeSha256 !==
      value.mutatedBuild.selectedTreeSha256 ||
    value.mutatedBuild.selectedTreeSha256 !== value.mutatedBuild.sourceSha256 ||
    value.mutatedBuild.sourceId !==
      `source:${value.mutatedBuild.sourceSha256}` ||
    value.mutatedBuild.sourceIdentitySha256 !== expectedSourceIdentity
  ) {
    reasons.push("mutant_source_identity_invalid");
  }
  if (
    value.trajectoryCaseSpec.classifierId !==
      M7_PATROL_TRAJECTORY_CLASSIFIER_ID_V1 ||
    value.trajectoryCaseSpec.classifierImplementationSha256 !==
      value.classifierImplementationSha256 ||
    value.trajectoryCaseSpec.classifierConfigSha256 !==
      value.classifierConfigSha256
  ) {
    reasons.push("trajectory_case_spec_mismatch");
  }
  const compatibility = value.adapterMutantCompatibility;
  if (!compatibility.cleanupProven || compatibility.outcome !== "compatible") {
    reasons.push("adapter_compatibility_not_compatible");
  }
  if (
    compatibility.buildRole !== "assignment_baseline" ||
    compatibility.baselineSourceHash !== value.mutatedBuild.sourceSha256 ||
    compatibility.buildId !== value.mutatedBuild.buildId ||
    compatibility.buildSourceId !== value.mutatedBuild.sourceId ||
    compatibility.buildSourceSha256 !== value.mutatedBuild.sourceSha256
  ) {
    reasons.push("adapter_compatibility_crossed_mutant_build");
  }
  if (
    compatibility.adapterRevisionId !==
      value.authoritativeAdapter.adapterRevisionId ||
    compatibility.adapterPristineSourceId !==
      value.authoritativeAdapter.pristineSourceId ||
    compatibility.adapterPackageSha256 !==
      value.authoritativeAdapter.packageSha256 ||
    compatibility.adapterObservationSchemaSha256 !==
      value.authoritativeAdapter.observationSchemaSha256
  ) {
    reasons.push("adapter_compatibility_crossed_pristine_adapter");
  }
  if (!value.cleanup.proven) {
    reasons.push("construction_cleanup_not_proven");
  }
  return reasons;
};

export const M7R3CaseConstructionReceiptV1Schema = constructionBasisSchema
  .extend({
    constructionId: constructionIdSchema,
    recordContentSha256: Sha256DigestV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const expectedReasons = deriveConstructionFailureReasons(value);
    if (!sameJson(value.failureReasons, expectedReasons)) {
      addIssue(
        context,
        ["failureReasons"],
        "construction failure reasons do not match retained facts",
      );
    }
    const expectedOutcome =
      expectedReasons.length === 0 ? "passed" : "construction_failed";
    if (value.outcome !== expectedOutcome) {
      addIssue(
        context,
        ["outcome"],
        "construction outcome does not match retained facts",
      );
    }
    const { constructionId, recordContentSha256, ...basis } = value;
    const expectedHash = digestJson(basis);
    if (
      constructionId !== `m7-r3-case-construction:${expectedHash.slice(0, 24)}`
    ) {
      addIssue(
        context,
        ["constructionId"],
        "construction ID does not derive from its content",
      );
    }
    if (recordContentSha256 !== expectedHash) {
      addIssue(
        context,
        ["recordContentSha256"],
        "construction content hash does not match",
      );
    }
  });
export type M7R3CaseConstructionReceiptV1 = z.infer<
  typeof M7R3CaseConstructionReceiptV1Schema
>;

export interface CreateM7R3CaseConstructionReceiptV1Input {
  readonly ordinal: 1 | 2;
  readonly trajectoryClassifierFreeze: unknown;
  readonly mutationRegistration: unknown;
  readonly mutatedBuild: unknown;
  readonly naturalPrompt: string;
  readonly trajectoryCaseSpec: unknown;
  readonly adapterMutantCompatibilityReceipt: unknown;
  readonly pairedPublicTaskContractBytes: string | Uint8Array;
  readonly preflightImplementationBytes: string | Uint8Array;
  readonly evaluatorImplementationBytes: string | Uint8Array;
  readonly evaluatorBundleBytes: string | Uint8Array;
  readonly cleanup: z.input<typeof cleanupProofSchema>;
  readonly constructedAt: string;
}

const materialIdentity = (
  value: string | Uint8Array,
  label: string,
): z.infer<typeof materialIdentitySchema> => {
  const bytes = materialBytes(value, label);
  return materialIdentitySchema.parse({
    byteLength: bytes.byteLength,
    sha256: digest(bytes),
  });
};

const naturalPromptIdentity = (
  value: string,
): z.infer<typeof promptIdentitySchema> => {
  const bytes = new TextEncoder().encode(value);
  if (
    value.trim().length === 0 ||
    value.includes("\0") ||
    bytes.byteLength > 64 * 1024
  ) {
    throw new TypeError(
      "M7 R3 natural prompt must be non-empty, NUL-free, and at most 64 KiB",
    );
  }
  return promptIdentitySchema.parse({
    utf8ByteLength: bytes.byteLength,
    utf8Sha256: digest(bytes),
    canonicalJsonSha256: digestJson(value),
  });
};

const validateGenericR3MutationPatch = (bytes: Uint8Array): void => {
  let patch: string;
  try {
    patch = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new TypeError("M7 R3 mutation patch must be valid UTF-8", {
      cause: error,
    });
  }
  if (patch.includes("\0") || patch.includes("\r") || !patch.endsWith("\n")) {
    throw new TypeError(
      "M7 R3 mutation patch must be NUL-free canonical LF text",
    );
  }
  if (
    /^(?:GIT binary patch|new file mode|deleted file mode|rename from|rename to|--- \/dev\/null|\+\+\+ \/dev\/null)$/mu.test(
      patch,
    )
  ) {
    throw new TypeError(
      "M7 R3 mutation patch cannot add, delete, rename, or encode binary files",
    );
  }
  const targets: string[] = [];
  for (const line of patch.split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const match = /^diff --git a\/([^\t ]+) b\/([^\t ]+)$/u.exec(line);
    if (match === null || match[1] !== match[2]) {
      throw new TypeError("M7 R3 mutation patch has a non-canonical target");
    }
    const target = match[1]!;
    if (
      target.startsWith("/") ||
      target.split("/").includes("..") ||
      !/\.(?:gd|tscn|tres)$/u.test(target) ||
      /^(?:\.git|\.godot|\.chronorift|addons)(?:\/|$)/u.test(target)
    ) {
      throw new TypeError("M7 R3 mutation patch targets a forbidden path");
    }
    targets.push(target);
  }
  if (
    targets.length < 1 ||
    targets.length > 16 ||
    new Set(targets).size !== targets.length
  ) {
    throw new TypeError(
      "M7 R3 mutation patch must change 1 to 16 unique source files",
    );
  }
  for (const target of targets) {
    if (
      !patch.includes(`--- a/${target}\n`) ||
      !patch.includes(`+++ b/${target}\n`)
    ) {
      throw new TypeError("M7 R3 mutation patch headers crossed their target");
    }
  }
  const changedLines = patch
    .split("\n")
    .filter(
      (line) =>
        (line.startsWith("+") && !line.startsWith("+++")) ||
        (line.startsWith("-") && !line.startsWith("---")),
    );
  if (changedLines.length < 1) {
    throw new TypeError("M7 R3 mutation patch does not change source bytes");
  }
};

export interface CreateM7R3MutationRegistrationV1Input {
  readonly trajectoryClassifierFreeze: unknown;
  readonly mutationBytes: string | Uint8Array;
  readonly mutatedBuild: unknown;
  readonly registeredAt: string;
}

/**
 * Registers a case-specific patch only after the generic trajectory
 * classifier has been frozen. Exact patch application and selected-tree
 * reproduction remain Host construction responsibilities; this pure record
 * binds their resulting exact Build identity without encoding a Bug locus.
 */
export const createM7R3MutationRegistrationV1 = (
  input: CreateM7R3MutationRegistrationV1Input,
) => {
  const freeze = M7R3TrajectoryClassifierFreezeV1Schema.parse(
    input.trajectoryClassifierFreeze,
  );
  const build = VNextBuildV1Schema.parse(input.mutatedBuild);
  const bytes = materialBytes(
    input.mutationBytes,
    "M7 R3 mutation patch",
    4 * 1024 * 1024,
  );
  validateGenericR3MutationPatch(bytes);
  const registeredAt = timestampSchema.parse(input.registeredAt);
  if (Date.parse(registeredAt) < Date.parse(freeze.frozenAt)) {
    throw new TypeError(
      "M7 R3 mutation cannot be registered before the generic classifier freeze",
    );
  }
  if (
    build.sourceId !== `source:${build.sourceHash}` ||
    build.sourceId === freeze.pristineSubject.sourceId ||
    build.sourceHash === freeze.pristineSubject.selectedTreeSha256
  ) {
    throw new TypeError(
      "M7 R3 mutation must bind a distinct exact mutant Build",
    );
  }
  const basis = {
    schemaVersion: 1 as const,
    sensorFreezeId: freeze.authoritativeSensorFreezeId,
    mutationSha256: digest(bytes),
    mutationByteLength: bytes.byteLength,
    mutatedSourceId: build.sourceId,
    mutatedSelectedTreeSha256: build.sourceHash,
    registeredAt,
  };
  const recordSha256 = digestJson(basis);
  return deepFreeze(
    M7HiddenMutationRegistrationV1Schema.parse({
      ...basis,
      mutationRegistrationId: `m7-mutation:${recordSha256.slice(0, 24)}`,
      recordSha256,
    }),
  );
};

export const createM7R3CaseConstructionReceiptV1 = (
  input: CreateM7R3CaseConstructionReceiptV1Input,
): M7R3CaseConstructionReceiptV1 => {
  const freeze = M7R3TrajectoryClassifierFreezeV1Schema.parse(
    input.trajectoryClassifierFreeze,
  );
  const mutation = M7HiddenMutationRegistrationV1Schema.parse(
    input.mutationRegistration,
  );
  const build = VNextBuildV1Schema.parse(input.mutatedBuild);
  const caseSpec = M7R3PatrolTrajectoryCaseSpecV1Schema.parse(
    input.trajectoryCaseSpec,
  );
  const compatibility = M6AdapterBuildCompatibilityReceiptV1Schema.parse(
    input.adapterMutantCompatibilityReceipt,
  );
  const mutatedBuild = sourceIdentitySchema.parse({
    buildId: build.buildId,
    buildRecordSha256: digestJson(build),
    buildCreatedAt: build.createdAt,
    sourceId: build.sourceId,
    sourceSha256: build.sourceHash,
    selectedTreeSha256: mutation.mutatedSelectedTreeSha256,
    sourceIdentitySha256: deriveM7BuildSourceIdentitySha256V1({
      sourceId: build.sourceId,
      sourceHash: build.sourceHash,
    }),
  });
  const compatibilityIdentity = compatibilityIdentitySchema.parse({
    receiptId: compatibility.receiptId,
    receiptRecordSha256: digestJson(compatibility),
    outcome: compatibility.outcome,
    buildRole: compatibility.lineage.buildRole,
    baselineSourceHash: compatibility.lineage.baselineSourceHash,
    buildId: compatibility.lineage.build.buildId,
    buildSourceId: compatibility.lineage.build.sourceId,
    buildSourceSha256: compatibility.lineage.build.sourceHash,
    adapterRevisionId: compatibility.lineage.adapterRevision.adapterRevisionId,
    adapterPristineSourceId: compatibility.lineage.adapterRevision.sourceId,
    adapterPackageSha256: compatibility.lineage.adapterRevision.packageDigest,
    adapterObservationSchemaSha256:
      compatibility.lineage.adapterRevision.payloadSchemaDigest,
    cleanupProven: compatibility.outcome === "compatible",
    observedAt: compatibility.observedAt,
  });
  const provisional = {
    schemaVersion: 1 as const,
    recordKind: "m7-r3-case-construction" as const,
    ordinal: caseOrdinalSchema.parse(input.ordinal),
    trajectoryClassifierFreezeId: freeze.classifierFreezeId,
    trajectoryClassifierFreezeRecordSha256: freeze.recordContentSha256,
    authoritativeSensorFreezeId: freeze.authoritativeSensorFreezeId,
    authoritativeSensorFreezeRecordSha256:
      freeze.authoritativeSensorFreezeRecordSha256,
    authoritativeAdapterRevisionRecordSha256:
      freeze.authoritativeAdapter.adapterRevisionRecordSha256,
    authoritativeAdapter: freeze.authoritativeAdapter,
    classifierImplementationSha256: freeze.classifierImplementationSha256,
    classifierConfigSha256: freeze.classifierConfig.configSha256,
    classifierFrozenAt: freeze.frozenAt,
    pristineSubject: freeze.pristineSubject,
    mutation: {
      mutationRegistrationId: mutation.mutationRegistrationId,
      mutationRegistrationRecordSha256: mutation.recordSha256,
      sensorFreezeId: mutation.sensorFreezeId,
      mutationSha256: mutation.mutationSha256,
      mutationByteLength: mutation.mutationByteLength,
      mutatedSourceId: mutation.mutatedSourceId,
      mutatedSelectedTreeSha256: mutation.mutatedSelectedTreeSha256,
      registeredAt: mutation.registeredAt,
    },
    mutatedBuild,
    naturalPrompt: naturalPromptIdentity(input.naturalPrompt),
    trajectoryCaseSpec: caseSpec,
    adapterMutantCompatibility: compatibilityIdentity,
    pairedPublicTaskContract: materialIdentity(
      input.pairedPublicTaskContractBytes,
      "M7 R3 paired public task contract",
    ),
    preflightImplementation: materialIdentity(
      input.preflightImplementationBytes,
      "M7 R3 preflight implementation",
    ),
    evaluatorImplementation: materialIdentity(
      input.evaluatorImplementationBytes,
      "M7 R3 evaluator implementation",
    ),
    evaluatorBundle: materialIdentity(
      input.evaluatorBundleBytes,
      "M7 R3 evaluator bundle",
    ),
    cleanup: cleanupProofSchema.parse(input.cleanup),
    constructedAt: timestampSchema.parse(input.constructedAt),
  };
  const basisWithoutDerived = constructionBasisSchema
    .omit({
      outcome: true,
      failureReasons: true,
    })
    .parse(provisional);
  const derivationBasis = constructionBasisSchema.parse({
    ...basisWithoutDerived,
    outcome: "passed",
    failureReasons: [],
  });
  const failureReasons = deriveConstructionFailureReasons(derivationBasis);
  const canonicalReasons =
    M7R3CaseConstructionFailureReasonV1Schema.options.filter((reason) =>
      failureReasons.includes(reason),
    );
  const basis = constructionBasisSchema.parse({
    ...basisWithoutDerived,
    outcome: canonicalReasons.length === 0 ? "passed" : "construction_failed",
    failureReasons: canonicalReasons,
  });
  const recordContentSha256 = digestJson(basis);
  return deepFreeze(
    M7R3CaseConstructionReceiptV1Schema.parse({
      ...basis,
      constructionId: `m7-r3-case-construction:${recordContentSha256.slice(0, 24)}`,
      recordContentSha256,
    }),
  );
};

export const M7R3PortfolioCaseConstructionProjectionV1Schema = z
  .object({
    subject: z
      .object({
        subjectProjectSha256: Sha256DigestV1Schema,
        pristineProjectRevision: gitRevisionSchema,
        pristineSelectedTreeSha256: Sha256DigestV1Schema,
      })
      .strict(),
    mutant: z
      .object({
        mutationSha256: Sha256DigestV1Schema,
        mutatedBuildSourceId: SourceIdSchema,
        mutatedBuildSourceSha256: Sha256DigestV1Schema,
        mutatedBaselineSelectedTreeSha256: Sha256DigestV1Schema,
        mutatedBuildSourceIdentitySha256: Sha256DigestV1Schema,
      })
      .strict(),
    naturalPromptUtf8Sha256: Sha256DigestV1Schema,
    trajectoryCaseSpecId: M7R3PatrolTrajectoryCaseSpecV1Schema.shape.caseId,
    trajectoryCaseSpecSha256: Sha256DigestV1Schema,
    adapterMutantCompatibilityReceiptSha256: Sha256DigestV1Schema,
    pairedPublicTaskContractSha256: Sha256DigestV1Schema,
    preflightImplementationSha256: Sha256DigestV1Schema,
    evaluatorImplementationSha256: Sha256DigestV1Schema,
    evaluatorBundleSha256: Sha256DigestV1Schema,
  })
  .strict();
export type M7R3PortfolioCaseConstructionProjectionV1 = z.infer<
  typeof M7R3PortfolioCaseConstructionProjectionV1Schema
>;

const constructionPortfolioProjection = (
  construction: M7R3CaseConstructionReceiptV1,
): M7R3PortfolioCaseConstructionProjectionV1 =>
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

/** Exact fields consumed by `createM7R3TwoCasePortfolioFreezeV1`. */
export const projectM7R3ConstructionToPortfolioCaseV1 = (
  input: unknown,
): M7R3PortfolioCaseConstructionProjectionV1 => {
  const construction = M7R3CaseConstructionReceiptV1Schema.parse(input);
  if (construction.outcome !== "passed") {
    throw new TypeError(
      "a failed construction cannot be projected into the frozen portfolio",
    );
  }
  return constructionPortfolioProjection(construction);
};

export const M7R3TrajectoryClassifierPortfolioBindingV1Schema = z
  .object({
    authoritativeSensorFreezeRecordSha256: Sha256DigestV1Schema,
    adapterRevisionSha256: Sha256DigestV1Schema,
    adapterPackageSha256: Sha256DigestV1Schema,
    adapterObservationSchemaSha256: Sha256DigestV1Schema,
    trajectoryClassifierFreezeRecordSha256: Sha256DigestV1Schema,
    trajectoryClassifierImplementationSha256: Sha256DigestV1Schema,
    trajectoryClassifierConfigSha256: Sha256DigestV1Schema,
    pristineAdapterConformanceReceiptSha256: Sha256DigestV1Schema,
  })
  .strict();

export const projectM7R3ClassifierFreezeToPortfolioV1 = (
  input: unknown,
): z.infer<typeof M7R3TrajectoryClassifierPortfolioBindingV1Schema> => {
  const freeze = M7R3TrajectoryClassifierFreezeV1Schema.parse(input);
  return M7R3TrajectoryClassifierPortfolioBindingV1Schema.parse({
    authoritativeSensorFreezeRecordSha256:
      freeze.authoritativeSensorFreezeRecordSha256,
    adapterRevisionSha256:
      freeze.authoritativeAdapter.adapterRevisionRecordSha256,
    adapterPackageSha256: freeze.authoritativeAdapter.packageSha256,
    adapterObservationSchemaSha256:
      freeze.authoritativeAdapter.observationSchemaSha256,
    trajectoryClassifierFreezeRecordSha256: freeze.recordContentSha256,
    trajectoryClassifierImplementationSha256:
      freeze.classifierImplementationSha256,
    trajectoryClassifierConfigSha256: freeze.classifierConfig.configSha256,
    pristineAdapterConformanceReceiptSha256:
      freeze.authoritativeAdapter.pristineConformanceReceiptSha256,
  });
};

const observationWitnessSchema = z
  .object({
    kind: M7PatrolTrajectoryWitnessKindV1Schema,
    witnessSha256: Sha256DigestV1Schema,
  })
  .strict();

const sandboxTaskCleanupReceiptSchema = z
  .object({
    processGroupTerminated: z.boolean(),
    cgroupPopulated: z.boolean(),
    termSent: z.boolean(),
    killSent: z.boolean(),
    scopeRemoved: z.boolean(),
    storageReconciled: z.boolean().optional(),
  })
  .strict();

const publicTrajectoryObservationBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-public-trajectory-preflight-observation"),
    subject: z.enum(["pristine", "mutant"]),
    taskId: TaskIdSchema,
    runtimeId: RuntimeIdSchema,
    executionId: ExecutionIdSchema,
    source: sourceIdentitySchema,
    configuredMainScene: mainSceneSchema,
    launchTarget: z.literal("configured_main_scene"),
    mainSceneLaunchObserved: z.boolean(),
    agentLaunchCount: z.literal(0),
    classifierFreezeRecordSha256: Sha256DigestV1Schema,
    classifierImplementationSha256: Sha256DigestV1Schema,
    classifierConfigSha256: Sha256DigestV1Schema,
    adapterRevisionRecordSha256: Sha256DigestV1Schema,
    adapterPackageIdentitySha256: Sha256DigestV1Schema,
    runtimeObservationReceiptSha256: Sha256DigestV1Schema,
    taskCleanup: z
      .object({
        proven: z.literal(true),
        receipt: sandboxTaskCleanupReceiptSchema,
        receiptSha256: Sha256DigestV1Schema,
      })
      .strict(),
    sandboxSecurityEvents: z
      .object({
        count: nonnegativeSafeIntegerSchema,
        receiptSha256: Sha256DigestV1Schema,
      })
      .strict(),
    captureRecordSealSha256: Sha256DigestV1Schema,
    trajectoryInputSha256: Sha256DigestV1Schema,
    trajectoryClassificationOutputSha256: Sha256DigestV1Schema,
    selectedWitnesses: z.array(observationWitnessSchema).max(5),
    coverage: z
      .object({
        complete: z.boolean(),
        observedFrameCount: z.number().int().min(2).max(100_000),
        observedEntitySampleCount: positiveSafeIntegerSchema,
        receiptSha256: Sha256DigestV1Schema,
      })
      .strict(),
    loss: z
      .object({
        historyLossObserved: z.boolean(),
        droppedRecordCount: nonnegativeSafeIntegerSchema,
        overwrittenRecordCount: nonnegativeSafeIntegerSchema,
        unavailableHistoryObserved: z.boolean(),
        receiptSha256: Sha256DigestV1Schema,
      })
      .strict(),
    cleanup: cleanupProofSchema,
    observedAt: timestampSchema,
  })
  .strict();

export const M7R3PublicTrajectoryPreflightObservationV1Schema =
  publicTrajectoryObservationBasisSchema
    .extend({ observationRecordSha256: Sha256DigestV1Schema })
    .strict()
    .superRefine((value, context) => {
      const taskCleanup = value.taskCleanup.receipt;
      if (
        value.taskCleanup.receiptSha256 !== digestJson(taskCleanup) ||
        !taskCleanup.processGroupTerminated ||
        taskCleanup.cgroupPopulated ||
        !taskCleanup.scopeRemoved ||
        taskCleanup.storageReconciled !== true
      ) {
        addIssue(
          context,
          ["taskCleanup"],
          "public trajectory Task cleanup is incomplete or its exact receipt hash changed",
        );
      }
      const expectedLoss =
        value.loss.droppedRecordCount > 0 ||
        value.loss.overwrittenRecordCount > 0 ||
        value.loss.unavailableHistoryObserved;
      if (value.loss.historyLossObserved !== expectedLoss) {
        addIssue(
          context,
          ["loss", "historyLossObserved"],
          "public trajectory history-loss flag does not match retained facts",
        );
      }
      const kinds = value.selectedWitnesses.map((entry) => entry.kind);
      const canonicalKinds = M7_PATROL_TRAJECTORY_WITNESS_KINDS_V1.filter(
        (kind) => kinds.includes(kind),
      );
      if (
        new Set(kinds).size !== kinds.length ||
        !sameJson(kinds, canonicalKinds)
      ) {
        addIssue(
          context,
          ["selectedWitnesses"],
          "selected public trajectory witnesses must be unique and canonically ordered",
        );
      }
      const { observationRecordSha256, ...basis } = value;
      if (observationRecordSha256 !== digestJson(basis)) {
        addIssue(
          context,
          ["observationRecordSha256"],
          "public trajectory observation hash does not match",
        );
      }
    });
export type M7R3PublicTrajectoryPreflightObservationV1 = z.infer<
  typeof M7R3PublicTrajectoryPreflightObservationV1Schema
>;

export interface CreateM7R3PublicTrajectoryPreflightObservationV1Input {
  readonly subject: "pristine" | "mutant";
  readonly trajectoryClassifierFreeze: unknown;
  readonly build: unknown;
  readonly selectedTreeSha256: Sha256DigestV1;
  readonly runtimeId: string;
  readonly executionId: string;
  readonly configuredMainScene: string;
  readonly mainSceneLaunchObserved: boolean;
  readonly adapterRevisionRecordSha256: Sha256DigestV1;
  readonly adapterPackageIdentitySha256: Sha256DigestV1;
  readonly runtimeObservationReceiptSha256: Sha256DigestV1;
  readonly taskCleanup: {
    readonly proven: true;
    readonly receipt: z.input<typeof sandboxTaskCleanupReceiptSchema>;
    readonly receiptSha256: Sha256DigestV1;
  };
  readonly sandboxSecurityEvents: {
    readonly count: number;
    readonly receiptSha256: Sha256DigestV1;
  };
  readonly captureRecordSealSha256: Sha256DigestV1;
  readonly timeline: M7PatrolStateTimelineV1;
  readonly coverageComplete: boolean;
  readonly coverageReceiptSha256: Sha256DigestV1;
  readonly loss: {
    readonly droppedRecordCount: number;
    readonly overwrittenRecordCount: number;
    readonly unavailableHistoryObserved: boolean;
    readonly receiptSha256: Sha256DigestV1;
  };
  readonly cleanup: z.input<typeof cleanupProofSchema>;
  readonly observedAt: string;
}

export const createM7R3PublicTrajectoryPreflightObservationV1 = (
  input: CreateM7R3PublicTrajectoryPreflightObservationV1Input,
): M7R3PublicTrajectoryPreflightObservationV1 => {
  const freeze = M7R3TrajectoryClassifierFreezeV1Schema.parse(
    input.trajectoryClassifierFreeze,
  );
  const build = VNextBuildV1Schema.parse(input.build);
  const runtimeId = RuntimeIdSchema.parse(input.runtimeId);
  const executionId = ExecutionIdSchema.parse(input.executionId);
  if (
    input.adapterRevisionRecordSha256 !==
    freeze.authoritativeAdapter.adapterRevisionRecordSha256
  ) {
    throw new TypeError(
      "public trajectory observation crossed the authoritative AdapterRevision record",
    );
  }
  if (input.timeline.execution_id !== executionId) {
    throw new TypeError(
      "public trajectory timeline crossed its Execution identity",
    );
  }
  const classification = classifyM7PatrolTrajectoryV1({
    timeline: input.timeline,
    config: freeze.classifierConfig,
  });
  const selectedWitnesses = M7_PATROL_TRAJECTORY_WITNESS_KINDS_V1.flatMap(
    (kind) => {
      const witness = classification.witnesses.find(
        (entry) => entry.kind === kind && !entry.fallOffEdge,
      );
      return witness === undefined
        ? []
        : [{ kind, witnessSha256: witness.witnessSha256 }];
    },
  );
  const historyLossObserved =
    input.loss.droppedRecordCount > 0 ||
    input.loss.overwrittenRecordCount > 0 ||
    input.loss.unavailableHistoryObserved;
  const basis = publicTrajectoryObservationBasisSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-r3-public-trajectory-preflight-observation",
    subject: input.subject,
    taskId: build.taskId,
    runtimeId,
    executionId,
    source: {
      buildId: build.buildId,
      buildRecordSha256: digestJson(build),
      buildCreatedAt: build.createdAt,
      sourceId: build.sourceId,
      sourceSha256: build.sourceHash,
      selectedTreeSha256: input.selectedTreeSha256,
      sourceIdentitySha256: deriveM7BuildSourceIdentitySha256V1({
        sourceId: build.sourceId,
        sourceHash: build.sourceHash,
      }),
    },
    configuredMainScene: input.configuredMainScene,
    launchTarget: "configured_main_scene",
    mainSceneLaunchObserved: input.mainSceneLaunchObserved,
    agentLaunchCount: 0,
    classifierFreezeRecordSha256: freeze.recordContentSha256,
    classifierImplementationSha256: freeze.classifierImplementationSha256,
    classifierConfigSha256: freeze.classifierConfig.configSha256,
    adapterRevisionRecordSha256: input.adapterRevisionRecordSha256,
    adapterPackageIdentitySha256: input.adapterPackageIdentitySha256,
    runtimeObservationReceiptSha256: input.runtimeObservationReceiptSha256,
    taskCleanup: input.taskCleanup,
    sandboxSecurityEvents: input.sandboxSecurityEvents,
    captureRecordSealSha256: input.captureRecordSealSha256,
    trajectoryInputSha256: classification.classifierInputSha256,
    trajectoryClassificationOutputSha256:
      classification.classificationOutputSha256,
    selectedWitnesses,
    coverage: {
      complete: input.coverageComplete,
      observedFrameCount: input.timeline.frames.length,
      observedEntitySampleCount: input.timeline.frames.reduce(
        (count, frame) => count + frame.entities.length,
        0,
      ),
      receiptSha256: input.coverageReceiptSha256,
    },
    loss: {
      historyLossObserved,
      ...input.loss,
    },
    cleanup: input.cleanup,
    observedAt: input.observedAt,
  });
  return deepFreeze(
    M7R3PublicTrajectoryPreflightObservationV1Schema.parse({
      ...basis,
      observationRecordSha256: digestJson(basis),
    }),
  );
};

const evaluatorFreshRunInputSchema = z
  .object({
    subject: z.enum(["pristine", "mutant"]),
    scenarioId: z.string().regex(/^m7-scenario:[a-z_]+:[1-3]$/u),
    workspaceIdentitySha256: Sha256DigestV1Schema,
    importCacheIdentitySha256: Sha256DigestV1Schema,
    processIdentitySha256: Sha256DigestV1Schema,
    workspaceCreationReceiptSha256: Sha256DigestV1Schema,
    importCacheCreationReceiptSha256: Sha256DigestV1Schema,
    processStartReceiptSha256: Sha256DigestV1Schema,
    cleanupReceiptSha256: Sha256DigestV1Schema,
  })
  .strict();

const evaluatorFreshRunBindingSchema = evaluatorFreshRunInputSchema
  .extend({
    runOrdinal: z.number().int().min(1).max(18),
    preflightRunReceiptSha256: Sha256DigestV1Schema,
  })
  .strict();

export type M7R3EvaluatorFreshRunInputV1 = z.input<
  typeof evaluatorFreshRunInputSchema
>;

export const M7R3CasePreflightFailureReasonV1Schema = z.enum([
  "construction_not_passed",
  "construction_does_not_match_portfolio",
  "portfolio_does_not_match_classifier_freeze",
  "portfolio_not_frozen_after_construction",
  "preflight_not_after_portfolio_freeze",
  "public_main_scene_mismatch",
  "public_main_scene_launch_missing",
  "public_observation_crossed_classifier",
  "pristine_public_source_mismatch",
  "mutant_public_source_mismatch",
  "pristine_recovery_witness_missing",
  "mutant_baseline_witness_missing",
  "public_observation_incomplete_or_lossy",
  "public_observation_cleanup_not_proven",
  "hidden_evaluator_identity_mismatch",
  "hidden_evaluator_lineage_mismatch",
  "hidden_evaluator_matrix_incomplete",
  "hidden_evaluator_matrix_unexpected",
  "hidden_evaluator_not_fresh",
  "hidden_evaluator_cleanup_not_proven",
  "hidden_evaluator_agent_launched",
]);
export type M7R3CasePreflightFailureReasonV1 = z.infer<
  typeof M7R3CasePreflightFailureReasonV1Schema
>;

const portfolioBindingSchema = z
  .object({
    portfolioId: M7R3TwoCasePortfolioFreezeV1Schema.shape.portfolioId,
    portfolioFreezeRecordSha256: Sha256DigestV1Schema,
    portfolioFrozenAt: timestampSchema,
    caseId: portfolioCaseIdSchema,
  })
  .strict();

const preflightBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-case-preflight"),
    ordinal: caseOrdinalSchema,
    portfolio: portfolioBindingSchema,
    portfolioFreeze: M7R3TwoCasePortfolioFreezeV1Schema,
    constructionId: constructionIdSchema,
    constructionReceiptSha256: Sha256DigestV1Schema,
    constructionReceipt: M7R3CaseConstructionReceiptV1Schema,
    trajectoryClassifierFreezeRecordSha256: Sha256DigestV1Schema,
    trajectoryClassifierFreeze: M7R3TrajectoryClassifierFreezeV1Schema,
    preflightImplementationSha256: Sha256DigestV1Schema,
    publicTrajectoryObservations: z
      .tuple([
        M7R3PublicTrajectoryPreflightObservationV1Schema,
        M7R3PublicTrajectoryPreflightObservationV1Schema,
      ])
      .superRefine((value, context) => {
        if (value[0].subject !== "pristine" || value[1].subject !== "mutant") {
          addIssue(
            context,
            [],
            "public observations must remain ordered pristine then mutant",
          );
        }
      }),
    hiddenEvaluator: z
      .object({
        implementationSha256: Sha256DigestV1Schema,
        bundleSha256: Sha256DigestV1Schema,
        matrix: M7PatrolPreflightResultV1Schema,
        freshRuns: z.array(evaluatorFreshRunBindingSchema).max(18),
      })
      .strict(),
    outcome: z.enum(["passed", "preflight_failed"]),
    failureReasons: z.array(M7R3CasePreflightFailureReasonV1Schema).max(21),
    completedAt: timestampSchema,
  })
  .strict();

type PreflightBasis = z.infer<typeof preflightBasisSchema>;

const portfolioCaseProjection = (
  value: M7R3TwoCasePortfolioFreezeV1["cases"][number],
): M7R3PortfolioCaseConstructionProjectionV1 =>
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

const containsKinds = (
  observation: M7R3PublicTrajectoryPreflightObservationV1,
  expected: readonly z.infer<typeof M7PatrolTrajectoryWitnessKindV1Schema>[],
): boolean => {
  const observed = new Set(
    observation.selectedWitnesses.map((witness) => witness.kind),
  );
  return expected.every((kind) => observed.has(kind));
};

const derivePreflightFailureReasons = (input: {
  readonly basis: PreflightBasis;
  readonly construction: M7R3CaseConstructionReceiptV1;
  readonly freeze: M7R3TrajectoryClassifierFreezeV1;
  readonly portfolio: M7R3TwoCasePortfolioFreezeV1;
}): readonly M7R3CasePreflightFailureReasonV1[] => {
  const { basis, construction, freeze, portfolio } = input;
  const reasons: M7R3CasePreflightFailureReasonV1[] = [];
  const portfolioCase = portfolio.cases[basis.ordinal - 1]!;
  if (construction.outcome !== "passed") {
    reasons.push("construction_not_passed");
  }
  if (
    !sameJson(
      constructionPortfolioProjection(construction),
      portfolioCaseProjection(portfolioCase),
    )
  ) {
    reasons.push("construction_does_not_match_portfolio");
  }
  const common = portfolio.commonRuntimeMaterials;
  const expectedCommon = projectM7R3ClassifierFreezeToPortfolioV1(freeze);
  if (
    Object.entries(expectedCommon).some(
      ([key, value]) => common[key as keyof typeof expectedCommon] !== value,
    )
  ) {
    reasons.push("portfolio_does_not_match_classifier_freeze");
  }
  if (Date.parse(portfolio.frozenAt) < Date.parse(construction.constructedAt)) {
    reasons.push("portfolio_not_frozen_after_construction");
  }
  if (
    Date.parse(basis.completedAt) < Date.parse(portfolio.frozenAt) ||
    basis.publicTrajectoryObservations.some(
      (observation) =>
        Date.parse(observation.observedAt) < Date.parse(portfolio.frozenAt),
    ) ||
    Date.parse(basis.hiddenEvaluator.matrix.completedAt) <
      Date.parse(portfolio.frozenAt)
  ) {
    reasons.push("preflight_not_after_portfolio_freeze");
  }
  const [pristine, mutant] = basis.publicTrajectoryObservations;
  if (pristine.configuredMainScene !== mutant.configuredMainScene) {
    reasons.push("public_main_scene_mismatch");
  }
  if (!pristine.mainSceneLaunchObserved || !mutant.mainSceneLaunchObserved) {
    reasons.push("public_main_scene_launch_missing");
  }
  if (
    basis.publicTrajectoryObservations.some(
      (observation) =>
        observation.classifierFreezeRecordSha256 !==
          freeze.recordContentSha256 ||
        observation.classifierImplementationSha256 !==
          freeze.classifierImplementationSha256 ||
        observation.classifierConfigSha256 !==
          freeze.classifierConfig.configSha256,
    )
  ) {
    reasons.push("public_observation_crossed_classifier");
  }
  if (
    pristine.source.sourceSha256 !==
      construction.pristineSubject.selectedTreeSha256 ||
    pristine.source.selectedTreeSha256 !==
      construction.pristineSubject.selectedTreeSha256 ||
    pristine.source.sourceId !== `source:${pristine.source.sourceSha256}`
  ) {
    reasons.push("pristine_public_source_mismatch");
  }
  if (
    mutant.source.buildId !== construction.mutatedBuild.buildId ||
    mutant.source.sourceId !== construction.mutatedBuild.sourceId ||
    mutant.source.sourceSha256 !== construction.mutatedBuild.sourceSha256 ||
    mutant.source.selectedTreeSha256 !==
      construction.mutatedBuild.selectedTreeSha256 ||
    mutant.source.sourceIdentitySha256 !==
      construction.mutatedBuild.sourceIdentitySha256
  ) {
    reasons.push("mutant_public_source_mismatch");
  }
  if (
    !containsKinds(
      pristine,
      construction.trajectoryCaseSpec.expectedRecoveryWitnessKinds,
    )
  ) {
    reasons.push("pristine_recovery_witness_missing");
  }
  if (
    !containsKinds(
      mutant,
      construction.trajectoryCaseSpec.expectedBaselineWitnessKinds,
    )
  ) {
    reasons.push("mutant_baseline_witness_missing");
  }
  if (
    basis.publicTrajectoryObservations.some(
      (observation) =>
        !observation.coverage.complete || observation.loss.historyLossObserved,
    )
  ) {
    reasons.push("public_observation_incomplete_or_lossy");
  }
  if (
    basis.publicTrajectoryObservations.some(
      (observation) => !observation.cleanup.proven,
    )
  ) {
    reasons.push("public_observation_cleanup_not_proven");
  }
  if (
    basis.hiddenEvaluator.implementationSha256 !==
      construction.evaluatorImplementation.sha256 ||
    basis.hiddenEvaluator.bundleSha256 !== construction.evaluatorBundle.sha256
  ) {
    reasons.push("hidden_evaluator_identity_mismatch");
  }
  const matrix = basis.hiddenEvaluator.matrix;
  if (
    matrix.sensorFreezeId !== freeze.authoritativeSensorFreezeId ||
    matrix.mutationRegistrationId !==
      construction.mutation.mutationRegistrationId
  ) {
    reasons.push("hidden_evaluator_lineage_mismatch");
  }
  if (
    matrix.summary.receivedRunCount !== 18 ||
    matrix.runs.length !== 18 ||
    basis.hiddenEvaluator.freshRuns.length !== 18
  ) {
    reasons.push("hidden_evaluator_matrix_incomplete");
  }
  if (
    matrix.outcome !== "passed" ||
    matrix.summary.pristineExpectedMotionObserved !== 9 ||
    matrix.summary.mutantPublicExpectedMotionObserved !== 0 ||
    matrix.summary.mutantHiddenExpectedMotionObserved !== 0 ||
    matrix.summary.mutantRegressionExpectedMotionObserved !== 3 ||
    matrix.summary.infrastructureFailures !== 0
  ) {
    reasons.push("hidden_evaluator_matrix_unexpected");
  }
  const freshIdentities = basis.hiddenEvaluator.freshRuns.flatMap((run) => [
    `workspace:${run.workspaceIdentitySha256}`,
    `import:${run.importCacheIdentitySha256}`,
    `process:${run.processIdentitySha256}`,
  ]);
  if (
    matrix.runs.some(
      (run) =>
        !run.freshWorkspaceCreated ||
        !run.freshImportCacheCreated ||
        !run.freshProcessStarted,
    ) ||
    new Set(freshIdentities).size !== freshIdentities.length ||
    matrix.summary.realizationFailures !== 0
  ) {
    reasons.push("hidden_evaluator_not_fresh");
  }
  if (
    matrix.runs.some((run) => !run.cleanupProven) ||
    matrix.summary.cleanupFailures !== 0
  ) {
    reasons.push("hidden_evaluator_cleanup_not_proven");
  }
  if (matrix.runs.some((run) => run.agentLaunchCount !== 0)) {
    reasons.push("hidden_evaluator_agent_launched");
  }
  return M7R3CasePreflightFailureReasonV1Schema.options.filter((reason) =>
    reasons.includes(reason),
  );
};

export const M7R3CasePreflightReceiptV1Schema = preflightBasisSchema
  .extend({
    preflightId: preflightIdSchema,
    recordContentSha256: Sha256DigestV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.portfolio.portfolioId !== value.portfolioFreeze.portfolioId ||
      value.portfolio.portfolioFreezeRecordSha256 !==
        value.portfolioFreeze.recordContentSha256 ||
      value.portfolio.portfolioFrozenAt !== value.portfolioFreeze.frozenAt ||
      value.portfolio.caseId !==
        value.portfolioFreeze.cases[value.ordinal - 1]?.caseId
    ) {
      addIssue(
        context,
        ["portfolio"],
        "preflight portfolio reference does not match its frozen snapshot",
      );
    }
    if (
      value.constructionId !== value.constructionReceipt.constructionId ||
      value.constructionReceiptSha256 !==
        value.constructionReceipt.recordContentSha256 ||
      value.constructionReceipt.ordinal !== value.ordinal
    ) {
      addIssue(
        context,
        ["constructionReceipt"],
        "preflight construction reference does not match its snapshot",
      );
    }
    if (
      value.trajectoryClassifierFreezeRecordSha256 !==
      value.trajectoryClassifierFreeze.recordContentSha256
    ) {
      addIssue(
        context,
        ["trajectoryClassifierFreeze"],
        "preflight classifier-freeze reference does not match its snapshot",
      );
    }
    const expectedReasons = derivePreflightFailureReasons({
      basis: value,
      construction: value.constructionReceipt,
      freeze: value.trajectoryClassifierFreeze,
      portfolio: value.portfolioFreeze,
    });
    if (!sameJson(value.failureReasons, expectedReasons)) {
      addIssue(
        context,
        ["failureReasons"],
        "preflight failure reasons do not match retained truth inputs",
      );
    }
    const expectedOutcome =
      expectedReasons.length === 0 ? "passed" : "preflight_failed";
    if (value.outcome !== expectedOutcome) {
      addIssue(
        context,
        ["outcome"],
        "preflight outcome does not match retained truth inputs",
      );
    }
    const { preflightId, recordContentSha256, ...basis } = value;
    const expectedHash = digestJson(basis);
    if (recordContentSha256 !== expectedHash) {
      addIssue(
        context,
        ["recordContentSha256"],
        "preflight content hash does not match its canonical bytes",
      );
    }
    const expectedId = `m7-r3-case-preflight:${expectedHash.slice(0, 24)}`;
    if (preflightId !== expectedId) {
      addIssue(
        context,
        ["preflightId"],
        "preflight ID does not derive from its content hash",
      );
    }
  });
export type M7R3CasePreflightReceiptV1 = z.infer<
  typeof M7R3CasePreflightReceiptV1Schema
>;

export interface CreateM7R3CasePreflightReceiptV1Input {
  readonly portfolioFreeze: unknown;
  readonly constructionReceipt: unknown;
  readonly trajectoryClassifierFreeze: unknown;
  readonly pristineObservation: CreateM7R3PublicTrajectoryPreflightObservationV1Input;
  readonly mutantObservation: CreateM7R3PublicTrajectoryPreflightObservationV1Input;
  readonly hiddenEvaluatorMatrix: unknown;
  readonly evaluatorFreshRuns: readonly M7R3EvaluatorFreshRunInputV1[];
  readonly completedAt: string;
}

const scenarioOrder = new Map(
  M7_PATROL_SCENARIO_PLAN_V1.map((scenario, index) => [
    scenario.scenarioId,
    index,
  ]),
);

export const createM7R3CasePreflightReceiptV1 = (
  input: CreateM7R3CasePreflightReceiptV1Input,
): M7R3CasePreflightReceiptV1 => {
  const portfolio = M7R3TwoCasePortfolioFreezeV1Schema.parse(
    input.portfolioFreeze,
  );
  const construction = M7R3CaseConstructionReceiptV1Schema.parse(
    input.constructionReceipt,
  );
  const freeze = M7R3TrajectoryClassifierFreezeV1Schema.parse(
    input.trajectoryClassifierFreeze,
  );
  const matrix = M7PatrolPreflightResultV1Schema.parse(
    input.hiddenEvaluatorMatrix,
  );
  const pristine = createM7R3PublicTrajectoryPreflightObservationV1({
    ...input.pristineObservation,
    subject: "pristine",
    trajectoryClassifierFreeze: freeze,
  });
  const mutant = createM7R3PublicTrajectoryPreflightObservationV1({
    ...input.mutantObservation,
    subject: "mutant",
    trajectoryClassifierFreeze: freeze,
  });
  const runByKey = new Map(
    matrix.runs.map((run) => [`${run.subject}\0${run.scenarioId}`, run]),
  );
  const freshRuns = input.evaluatorFreshRuns
    .map((freshInput) => evaluatorFreshRunInputSchema.parse(freshInput))
    .sort((left, right) => {
      const leftSubject = left.subject === "pristine" ? 0 : 1;
      const rightSubject = right.subject === "pristine" ? 0 : 1;
      return (
        leftSubject - rightSubject ||
        (scenarioOrder.get(left.scenarioId) ?? 99) -
          (scenarioOrder.get(right.scenarioId) ?? 99)
      );
    })
    .map((fresh, index) => {
      const run = runByKey.get(`${fresh.subject}\0${fresh.scenarioId}`);
      if (run === undefined) {
        throw new TypeError(
          "fresh evaluator binding has no matching matrix run receipt",
        );
      }
      return evaluatorFreshRunBindingSchema.parse({
        ...fresh,
        runOrdinal: index + 1,
        preflightRunReceiptSha256: digestJson(run),
      });
    });
  const keys = freshRuns.map((run) => `${run.subject}\0${run.scenarioId}`);
  if (new Set(keys).size !== keys.length) {
    throw new TypeError("fresh evaluator bindings cannot repeat a matrix run");
  }
  const portfolioCase = portfolio.cases[construction.ordinal - 1]!;
  const basisWithoutDerived = preflightBasisSchema
    .omit({
      outcome: true,
      failureReasons: true,
    })
    .parse({
      schemaVersion: 1,
      recordKind: "m7-r3-case-preflight",
      ordinal: construction.ordinal,
      portfolio: {
        portfolioId: portfolio.portfolioId,
        portfolioFreezeRecordSha256: portfolio.recordContentSha256,
        portfolioFrozenAt: portfolio.frozenAt,
        caseId: portfolioCase.caseId,
      },
      portfolioFreeze: portfolio,
      constructionId: construction.constructionId,
      constructionReceiptSha256: construction.recordContentSha256,
      constructionReceipt: construction,
      trajectoryClassifierFreezeRecordSha256: freeze.recordContentSha256,
      trajectoryClassifierFreeze: freeze,
      preflightImplementationSha256:
        construction.preflightImplementation.sha256,
      publicTrajectoryObservations: [pristine, mutant],
      hiddenEvaluator: {
        implementationSha256: construction.evaluatorImplementation.sha256,
        bundleSha256: construction.evaluatorBundle.sha256,
        matrix,
        freshRuns,
      },
      completedAt: timestampSchema.parse(input.completedAt),
    });
  const provisional = preflightBasisSchema.parse({
    ...basisWithoutDerived,
    outcome: "passed",
    failureReasons: [],
  });
  const failureReasons = derivePreflightFailureReasons({
    basis: provisional,
    construction,
    freeze,
    portfolio,
  });
  const basis = preflightBasisSchema.parse({
    ...basisWithoutDerived,
    outcome: failureReasons.length === 0 ? "passed" : "preflight_failed",
    failureReasons,
  });
  const recordContentSha256 = digestJson(basis);
  return deepFreeze(
    M7R3CasePreflightReceiptV1Schema.parse({
      ...basis,
      preflightId: `m7-r3-case-preflight:${recordContentSha256.slice(0, 24)}`,
      recordContentSha256,
    }),
  );
};

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

const requireEffectiveUserId = (): number => {
  const uid = process.geteuid?.();
  if (uid === undefined) {
    throw new Error("M7 R3 construction store requires effective-user checks");
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
  if (!isAbsolute(inputPath)) {
    throw new Error(`${label} must be an absolute canonical path`);
  }
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

type RecordKind =
  | "classifier-freeze"
  | "case-1-construction"
  | "case-2-construction"
  | "case-1-preflight"
  | "case-2-preflight";

const recordName = (kind: RecordKind): string => {
  switch (kind) {
    case "classifier-freeze":
      return "m7-r3.trajectory-classifier-freeze.json";
    case "case-1-construction":
      return "m7-r3.case-01-construction.json";
    case "case-2-construction":
      return "m7-r3.case-02-construction.json";
    case "case-1-preflight":
      return "m7-r3.case-01-preflight.json";
    case "case-2-preflight":
      return "m7-r3.case-02-preflight.json";
  }
};

const constructionKind = (ordinal: 1 | 2): RecordKind =>
  ordinal === 1 ? "case-1-construction" : "case-2-construction";
const preflightKind = (ordinal: 1 | 2): RecordKind =>
  ordinal === 1 ? "case-1-preflight" : "case-2-preflight";

export class M7R3CaseConstructionStoreV1 {
  readonly #root: string;
  readonly #identity: PrivateRootIdentity;

  private constructor(root: string, identity: PrivateRootIdentity) {
    this.#root = root;
    this.#identity = identity;
  }

  public static async open(input: {
    readonly root: string;
    readonly exposedRoots: readonly string[];
  }): Promise<M7R3CaseConstructionStoreV1> {
    const { canonical: root, metadata } = await canonicalDirectory(
      input.root,
      "M7 R3 Host-only construction root",
    );
    if (
      metadata.uid !== requireEffectiveUserId() ||
      (metadata.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE
    ) {
      throw new Error(
        "M7 R3 Host-only construction root must be owned by the current user with mode 0700",
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
          "M7 R3 Host-only construction root must be disjoint from Agent-exposed roots",
        );
      }
    }
    return new M7R3CaseConstructionStoreV1(root, {
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
      throw new Error("M7 R3 Host-only construction root identity changed");
    }
  }

  #path(kind: RecordKind): string {
    return resolve(this.#root, recordName(kind));
  }

  async #writeOnce(kind: RecordKind, value: unknown): Promise<void> {
    await this.#requireRoot();
    const path = this.#path(kind);
    if (!pathWithinOrEqual(this.#root, path)) {
      throw new Error("M7 R3 construction record escaped its Host-only root");
    }
    const bytes = Buffer.from(
      `${canonicalJson(JsonValueSchema.parse(value))}\n`,
      "utf8",
    );
    if (bytes.byteLength > RECORD_BYTE_LIMIT) {
      throw new Error("M7 R3 construction record exceeds its byte limit");
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
          `M7 R3 ${kind} already exists; overwrite, retry, and reroll are forbidden`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async #read<T>(kind: RecordKind, parse: (value: unknown) => T): Promise<T> {
    await this.#requireRoot();
    const path = this.#path(kind);
    if (!pathWithinOrEqual(this.#root, path)) {
      throw new Error("M7 R3 construction record escaped its Host-only root");
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
        "M7 R3 construction record must remain a canonical one-link owned mode-0600 regular file",
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
          "M7 R3 construction record identity changed while opening",
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
        throw new Error("M7 R3 construction record is not valid UTF-8 JSON", {
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
        throw new Error("M7 R3 construction record changed while reading");
      }
      return parse(value);
    } finally {
      await handle.close();
    }
  }

  public async createClassifierFreezeOnce(
    input: CreateM7R3TrajectoryClassifierFreezeV1Input,
  ): Promise<M7R3TrajectoryClassifierFreezeV1> {
    const record = createM7R3TrajectoryClassifierFreezeV1(input);
    await this.#writeOnce("classifier-freeze", record);
    return record;
  }

  public readClassifierFreeze(): Promise<M7R3TrajectoryClassifierFreezeV1> {
    return this.#read("classifier-freeze", (value) =>
      M7R3TrajectoryClassifierFreezeV1Schema.parse(value),
    );
  }

  public async createConstructionOnce(
    input: Omit<
      CreateM7R3CaseConstructionReceiptV1Input,
      "trajectoryClassifierFreeze"
    >,
  ): Promise<M7R3CaseConstructionReceiptV1> {
    const freeze = await this.readClassifierFreeze();
    const record = createM7R3CaseConstructionReceiptV1({
      ...input,
      trajectoryClassifierFreeze: freeze,
    });
    await this.#writeOnce(constructionKind(record.ordinal), record);
    return record;
  }

  public readConstruction(
    ordinal: 1 | 2,
  ): Promise<M7R3CaseConstructionReceiptV1> {
    return this.#read(constructionKind(ordinal), (value) => {
      const record = M7R3CaseConstructionReceiptV1Schema.parse(value);
      if (record.ordinal !== ordinal) {
        throw new Error("M7 R3 construction crossed its fixed ordinal");
      }
      return record;
    });
  }

  public async createPreflightOnce(
    input: Omit<
      CreateM7R3CasePreflightReceiptV1Input,
      "constructionReceipt" | "trajectoryClassifierFreeze"
    > & { readonly ordinal: 1 | 2 },
  ): Promise<M7R3CasePreflightReceiptV1> {
    const [freeze, construction] = await Promise.all([
      this.readClassifierFreeze(),
      this.readConstruction(input.ordinal),
    ]);
    if (construction.outcome !== "passed") {
      throw new Error(
        "M7 R3 preflight cannot run after a retained construction failure",
      );
    }
    const record = createM7R3CasePreflightReceiptV1({
      ...input,
      constructionReceipt: construction,
      trajectoryClassifierFreeze: freeze,
    });
    await this.#writeOnce(preflightKind(input.ordinal), record);
    return record;
  }

  /**
   * Persists the runner's already-finalized receipt without reconstructing or
   * weakening it. The exact full DTO is rebound to this store's authoritative
   * classifier/construction records and returned only after a durable reread.
   */
  public async persistPreflightOnce(
    receiptInput: M7R3CasePreflightReceiptV1,
  ): Promise<M7R3CasePreflightReceiptV1> {
    const receipt = M7R3CasePreflightReceiptV1Schema.parse(receiptInput);
    const [freeze, construction] = await Promise.all([
      this.readClassifierFreeze(),
      this.readConstruction(receipt.ordinal),
    ]);
    if (
      construction.outcome !== "passed" ||
      receipt.constructionId !== construction.constructionId ||
      receipt.constructionReceiptSha256 !== construction.recordContentSha256 ||
      receipt.trajectoryClassifierFreezeRecordSha256 !==
        freeze.recordContentSha256 ||
      !sameJson(receipt.constructionReceipt, construction) ||
      !sameJson(receipt.trajectoryClassifierFreeze, freeze)
    ) {
      throw new Error(
        "M7 R3 final preflight receipt crossed its authoritative classifier or construction record",
      );
    }
    await this.#writeOnce(preflightKind(receipt.ordinal), receipt);
    const stored = await this.readPreflight(receipt.ordinal);
    if (!sameJson(stored, receipt)) {
      throw new Error("M7 R3 final preflight receipt changed during storage");
    }
    return stored;
  }

  public readPreflight(ordinal: 1 | 2): Promise<M7R3CasePreflightReceiptV1> {
    return this.#read(preflightKind(ordinal), (value) => {
      const record = M7R3CasePreflightReceiptV1Schema.parse(value);
      if (record.ordinal !== ordinal) {
        throw new Error("M7 R3 preflight crossed its fixed ordinal");
      }
      return record;
    });
  }
}

export const openM7R3CaseConstructionStoreV1 = (input: {
  readonly root: string;
  readonly exposedRoots: readonly string[];
}): Promise<M7R3CaseConstructionStoreV1> =>
  M7R3CaseConstructionStoreV1.open(input);
