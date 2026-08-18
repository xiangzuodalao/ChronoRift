import { createHash } from "node:crypto";

import {
  AdapterConformanceReceiptIdSchema,
  JsonValueSchema,
  ProjectAdapterRevisionIdSchema,
  Sha256DigestV1Schema,
  SourceIdSchema,
  asSha256DigestV1,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { z } from "zod";

export const M7_MODDABLE_PLATFORMER_REPOSITORY_V1 =
  "https://github.com/endlessm/moddable-platformer.git" as const;
export const M7_MODDABLE_PLATFORMER_REVISION_V1 =
  "3e793f53598a131c53fb82555191cc14b8db07ff" as const;
export const M7_PATROL_OBSERVATION_SCHEMA_ID_V1 =
  "chronorift.generic-patrol-state.v1" as const;
export const M7_PATROL_CLASSIFIER_ID_V1 =
  "chronorift.generic-patrol-sequence.v1" as const;

const timestampSchema = z.string().datetime({ offset: true });
const opaqueIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u)
  .refine((value) => !value.includes(".."));
const sensorFreezeIdSchema = z
  .string()
  .regex(/^m7-sensor-freeze:[a-f0-9]{24}$/u);
const mutationRegistrationIdSchema = z
  .string()
  .regex(/^m7-mutation:[a-f0-9]{24}$/u);
const preflightResultIdSchema = z
  .string()
  .regex(/^m7-preflight:[a-f0-9]{24}$/u);
const finiteNumberSchema = z.number().finite();
const patrolStartDirectionSchema = z.union([z.literal(0), z.literal(1)]);
const patrolDirectionSchema = z.union([z.literal(-1), z.literal(1)]);

const digest = (bytes: string | Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

const digestJson = (value: unknown): Sha256DigestV1 =>
  digest(canonicalJson(JsonValueSchema.parse(value)));

const deepFreeze = <T>(value: T): Readonly<T> => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
};

const addHashMismatch = (
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  message: string,
): void => {
  context.addIssue({ code: "custom", path: [...path], message });
};

/**
 * The public state emitted by the pre-registered Adapter. It deliberately
 * describes ordinary patrol motion only. Strict parsing prevents either arm
 * from smuggling extra implementation-specific fields into a witness.
 */
export const M7PatrolEntityStateV1Schema = z
  .object({
    entity_id: opaqueIdSchema,
    name: z.string().min(1).max(512),
    start_direction: patrolStartDirectionSchema,
    direction: patrolDirectionSchema,
    fall_off_edge: z.boolean(),
    speed: finiteNumberSchema.nonnegative(),
    position_x: finiteNumberSchema,
    position_y: finiteNumberSchema,
    velocity_x: finiteNumberSchema,
    velocity_y: finiteNumberSchema,
    grounded: z.boolean(),
  })
  .strict();
export type M7PatrolEntityStateV1 = z.infer<typeof M7PatrolEntityStateV1Schema>;

export const M7PatrolStateFrameV1Schema = z
  .object({
    sample_ordinal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    entities: z.array(M7PatrolEntityStateV1Schema).min(1).max(4_096),
  })
  .strict()
  .superRefine((value, context) => {
    const identities = new Set<string>();
    for (const [index, entity] of value.entities.entries()) {
      if (identities.has(entity.entity_id)) {
        context.addIssue({
          code: "custom",
          path: ["entities", index, "entity_id"],
          message: "an entity may appear only once in a patrol state frame",
        });
      }
      identities.add(entity.entity_id);
    }
  });
export type M7PatrolStateFrameV1 = z.infer<typeof M7PatrolStateFrameV1Schema>;

export const M7PatrolStateTimelineV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    execution_id: opaqueIdSchema,
    frames: z.array(M7PatrolStateFrameV1Schema).min(2).max(100_000),
  })
  .strict()
  .superRefine((value, context) => {
    let previousOrdinal = -1;
    const configurationByEntity = new Map<
      string,
      Pick<
        M7PatrolEntityStateV1,
        "name" | "start_direction" | "fall_off_edge" | "speed"
      >
    >();
    for (const [frameIndex, frame] of value.frames.entries()) {
      if (frame.sample_ordinal <= previousOrdinal) {
        context.addIssue({
          code: "custom",
          path: ["frames", frameIndex, "sample_ordinal"],
          message: "patrol sample ordinals must be strictly increasing",
        });
      }
      previousOrdinal = frame.sample_ordinal;
      for (const [entityIndex, entity] of frame.entities.entries()) {
        const previous = configurationByEntity.get(entity.entity_id);
        if (
          previous !== undefined &&
          (previous.name !== entity.name ||
            previous.start_direction !== entity.start_direction ||
            previous.fall_off_edge !== entity.fall_off_edge ||
            previous.speed !== entity.speed)
        ) {
          context.addIssue({
            code: "custom",
            path: ["frames", frameIndex, "entities", entityIndex],
            message:
              "the public patrol configuration must remain stable within an execution",
          });
        } else if (previous === undefined) {
          configurationByEntity.set(entity.entity_id, {
            name: entity.name,
            start_direction: entity.start_direction,
            fall_off_edge: entity.fall_off_edge,
            speed: entity.speed,
          });
        }
      }
    }
  });
export type M7PatrolStateTimelineV1 = z.infer<
  typeof M7PatrolStateTimelineV1Schema
>;

export const M7PatrolSequenceWitnessV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.enum([
      "no_reversal_before_grounded_to_falling",
      "reversal_without_falling",
    ]),
    entity_id: opaqueIdSchema,
    name: z.string().min(1).max(512),
    first_sample_ordinal: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    last_sample_ordinal: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.last_sample_ordinal <= value.first_sample_ordinal) {
      context.addIssue({
        code: "custom",
        path: ["last_sample_ordinal"],
        message: "a sequence witness must span at least two samples",
      });
    }
  });
export type M7PatrolSequenceWitnessV1 = z.infer<
  typeof M7PatrolSequenceWitnessV1Schema
>;

export const M7PatrolClassificationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    classifier_id: z.literal(M7_PATROL_CLASSIFIER_ID_V1),
    input_sha256: Sha256DigestV1Schema,
    witnesses: z.array(M7PatrolSequenceWitnessV1Schema).max(4_096),
  })
  .strict();
export type M7PatrolClassificationV1 = z.infer<
  typeof M7PatrolClassificationV1Schema
>;

/**
 * Exact output vocabulary of the pre-mutation frozen public classifier used
 * by the M7 live assignment.  This is intentionally separate from the small
 * in-process classifier above: the formal campaign must retain what the
 * frozen classifier bytes actually emitted for Agent-visible game-tool
 * responses, not silently substitute a later implementation.
 */
export const M7FrozenPatrolClassifierWitnessV1Schema = z
  .object({
    entityId: opaqueIdSchema,
    name: z.string().min(1).max(512),
    outcome: z.enum(["fell_without_reversing", "reversed_while_grounded"]),
    fromFrame: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    toFrame: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    startDirection: patrolDirectionSchema,
    endDirection: patrolDirectionSchema,
    startY: finiteNumberSchema,
    endY: finiteNumberSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.toFrame <= value.fromFrame) {
      context.addIssue({
        code: "custom",
        path: ["toFrame"],
        message: "a frozen patrol classifier witness must span two frames",
      });
    }
    if (
      value.outcome === "fell_without_reversing" &&
      value.endDirection !== value.startDirection
    ) {
      context.addIssue({
        code: "custom",
        path: ["endDirection"],
        message: "a fall witness cannot also claim a direction reversal",
      });
    }
    if (
      value.outcome === "reversed_while_grounded" &&
      value.endDirection !== -value.startDirection
    ) {
      context.addIssue({
        code: "custom",
        path: ["endDirection"],
        message: "a reversal witness must end in the opposite direction",
      });
    }
  });
export type M7FrozenPatrolClassifierWitnessV1 = z.infer<
  typeof M7FrozenPatrolClassifierWitnessV1Schema
>;

export const M7FrozenPatrolClassifierOutputV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    stateDomainId: z.literal("patrol.motion"),
    classification: z.enum([
      "fell_without_reversing",
      "reversed_while_grounded",
      "mixed",
      "insufficient_observation",
    ]),
    declaredSampleCount: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    entityCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    fallWitnessCount: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    reversalWitnessCount: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    witnesses: z.array(M7FrozenPatrolClassifierWitnessV1Schema).max(4_096),
  })
  .strict()
  .superRefine((value, context) => {
    const fallWitnessCount = value.witnesses.filter(
      (witness) => witness.outcome === "fell_without_reversing",
    ).length;
    const reversalWitnessCount = value.witnesses.filter(
      (witness) => witness.outcome === "reversed_while_grounded",
    ).length;
    if (value.fallWitnessCount !== fallWitnessCount) {
      context.addIssue({
        code: "custom",
        path: ["fallWitnessCount"],
        message: "frozen classifier fall count does not match its witnesses",
      });
    }
    if (value.reversalWitnessCount !== reversalWitnessCount) {
      context.addIssue({
        code: "custom",
        path: ["reversalWitnessCount"],
        message:
          "frozen classifier reversal count does not match its witnesses",
      });
    }
    const expectedClassification =
      fallWitnessCount > 0
        ? reversalWitnessCount > 0
          ? "mixed"
          : "fell_without_reversing"
        : reversalWitnessCount > 0
          ? "reversed_while_grounded"
          : "insufficient_observation";
    if (value.classification !== expectedClassification) {
      context.addIssue({
        code: "custom",
        path: ["classification"],
        message:
          "frozen classifier category must derive from its retained witnesses",
      });
    }
    const witnessedEntities = new Set(
      value.witnesses.map((witness) => witness.entityId),
    ).size;
    if (
      value.entityCount < witnessedEntities ||
      value.declaredSampleCount < value.witnesses.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["entityCount"],
        message:
          "frozen classifier counts cannot be smaller than retained evidence",
      });
    }
  });
export type M7FrozenPatrolClassifierOutputV1 = z.infer<
  typeof M7FrozenPatrolClassifierOutputV1Schema
>;

/**
 * Recognizes two observable motion sequences. It neither diagnoses why the
 * motion occurred nor decides whether a candidate should be accepted.
 */
export const classifyM7PatrolTimelineV1 = (
  input: M7PatrolStateTimelineV1,
): M7PatrolClassificationV1 => {
  const timeline = M7PatrolStateTimelineV1Schema.parse(input);
  const byEntity = new Map<
    string,
    Array<{ readonly ordinal: number; readonly state: M7PatrolEntityStateV1 }>
  >();
  for (const frame of timeline.frames) {
    for (const state of frame.entities) {
      const observations = byEntity.get(state.entity_id) ?? [];
      observations.push({ ordinal: frame.sample_ordinal, state });
      byEntity.set(state.entity_id, observations);
    }
  }

  const witnesses: M7PatrolSequenceWitnessV1[] = [];
  for (const observations of byEntity.values()) {
    const first = observations[0];
    const last = observations.at(-1);
    if (
      first === undefined ||
      last === undefined ||
      observations.length < 2 ||
      first.state.fall_off_edge
    ) {
      continue;
    }
    const configuredDirection =
      first.state.start_direction === 0 ? (-1 as const) : (1 as const);
    const firstGroundedIndex = observations.findIndex(
      ({ state }) => state.grounded && state.direction === configuredDirection,
    );
    if (firstGroundedIndex < 0) continue;
    const afterGrounded = observations.slice(firstGroundedIndex);
    const reversalIndex = afterGrounded.findIndex(
      ({ state }) => state.direction === -configuredDirection,
    );
    const fallingIndex = afterGrounded.findIndex(
      ({ state }) => !state.grounded && state.velocity_y > 0,
    );

    if (
      fallingIndex >= 0 &&
      (reversalIndex < 0 || reversalIndex > fallingIndex)
    ) {
      const falling = afterGrounded[fallingIndex];
      if (falling !== undefined) {
        witnesses.push({
          schemaVersion: 1,
          kind: "no_reversal_before_grounded_to_falling",
          entity_id: first.state.entity_id,
          name: first.state.name,
          first_sample_ordinal: afterGrounded[0]?.ordinal ?? first.ordinal,
          last_sample_ordinal: falling.ordinal,
        });
      }
      continue;
    }

    if (reversalIndex >= 0 && fallingIndex < 0) {
      const reversed = afterGrounded[reversalIndex];
      if (reversed !== undefined) {
        witnesses.push({
          schemaVersion: 1,
          kind: "reversal_without_falling",
          entity_id: first.state.entity_id,
          name: first.state.name,
          first_sample_ordinal: afterGrounded[0]?.ordinal ?? first.ordinal,
          last_sample_ordinal: last.ordinal,
        });
      }
    }
  }

  witnesses.sort((left, right) =>
    left.entity_id.localeCompare(right.entity_id, "en"),
  );
  return M7PatrolClassificationV1Schema.parse({
    schemaVersion: 1,
    classifier_id: M7_PATROL_CLASSIFIER_ID_V1,
    input_sha256: digestJson(timeline),
    witnesses,
  });
};

const pristineSubjectSchema = z
  .object({
    repository: z.literal(M7_MODDABLE_PLATFORMER_REPOSITORY_V1),
    revision: z.literal(M7_MODDABLE_PLATFORMER_REVISION_V1),
    sourceId: SourceIdSchema,
    subjectProjectSha256: Sha256DigestV1Schema,
    selectedTreeSha256: Sha256DigestV1Schema,
  })
  .strict();

const frozenSensorIdentitySchema = z
  .object({
    adapterRevisionId: ProjectAdapterRevisionIdSchema,
    adapterPackageSha256: Sha256DigestV1Schema,
    observationSchemaId: z.literal(M7_PATROL_OBSERVATION_SCHEMA_ID_V1),
    observationSchemaSha256: Sha256DigestV1Schema,
    classifierId: z.literal(M7_PATROL_CLASSIFIER_ID_V1),
    classifierImplementationSha256: Sha256DigestV1Schema,
    pristineConformanceReceiptId: AdapterConformanceReceiptIdSchema,
    pristineConformanceReceiptSha256: Sha256DigestV1Schema,
  })
  .strict();

const sensorFreezeBasis = (value: {
  readonly schemaVersion: 1;
  readonly pristineSubject: z.infer<typeof pristineSubjectSchema>;
  readonly sensor: z.infer<typeof frozenSensorIdentitySchema>;
  readonly frozenAt: string;
}) => ({
  schemaVersion: value.schemaVersion,
  pristineSubject: value.pristineSubject,
  sensor: value.sensor,
  frozenAt: value.frozenAt,
});

export const M7SensorFreezeRecordV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sensorFreezeId: sensorFreezeIdSchema,
    pristineSubject: pristineSubjectSchema,
    sensor: frozenSensorIdentitySchema,
    frozenAt: timestampSchema,
    recordSha256: Sha256DigestV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const expectedHash = digestJson(sensorFreezeBasis(value));
    if (value.recordSha256 !== expectedHash) {
      addHashMismatch(
        context,
        ["recordSha256"],
        "M7 sensor freeze record content hash does not match",
      );
    }
    if (
      value.sensorFreezeId !== `m7-sensor-freeze:${expectedHash.slice(0, 24)}`
    ) {
      addHashMismatch(
        context,
        ["sensorFreezeId"],
        "M7 sensor freeze identity does not match its frozen content",
      );
    }
  });
export type M7SensorFreezeRecordV1 = z.infer<
  typeof M7SensorFreezeRecordV1Schema
>;

export interface M7SensorMaterialBytesV1 {
  readonly adapterPackageBytes: string | Uint8Array;
  readonly observationSchemaBytes: string | Uint8Array;
  readonly classifierImplementationBytes: string | Uint8Array;
  readonly pristineConformanceReceiptBytes: string | Uint8Array;
}

export interface CreateM7SensorFreezeRecordV1Input {
  readonly schemaVersion: 1;
  readonly pristineSubject: z.input<typeof pristineSubjectSchema>;
  readonly adapterRevisionId: z.input<typeof ProjectAdapterRevisionIdSchema>;
  readonly pristineConformanceReceiptId: z.input<
    typeof AdapterConformanceReceiptIdSchema
  >;
  readonly materials: M7SensorMaterialBytesV1;
  readonly frozenAt: string;
}

const publicSensorForbiddenPattern =
  /(?:\bray[ _.-]*cast(?:\b|_)|\bleft[ _.-]*ray(?:\b|_)|\bright[ _.-]*ray(?:\b|_)|\bcollision[ _.-]*mask(?:\b|_)|\bnode[ _.-]*path(?:\b|_)|\bsource[ _.-]*(?:path|locus)(?:\b|_)|\bfix(?:es|ed|ing)?\b)/iu;

const requireGenericPublicBytes = (
  bytes: string | Uint8Array,
  label: string,
): void => {
  const content =
    typeof bytes === "string"
      ? bytes
      : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (content.length < 1 || content.length > 4 * 1024 * 1024) {
    throw new Error(`${label} must contain between 1 byte and 4 MiB`);
  }
  if (publicSensorForbiddenPattern.test(content)) {
    throw new Error(`${label} contains implementation-specific vocabulary`);
  }
};

const requireBoundedMaterial = (
  bytes: string | Uint8Array,
  label: string,
): void => {
  const byteLength =
    typeof bytes === "string"
      ? Buffer.byteLength(bytes, "utf8")
      : bytes.byteLength;
  if (byteLength < 1 || byteLength > 64 * 1024 * 1024) {
    throw new Error(`${label} must contain between 1 byte and 64 MiB`);
  }
};

export const createM7SensorFreezeRecordV1 = (
  input: CreateM7SensorFreezeRecordV1Input,
): M7SensorFreezeRecordV1 => {
  requireBoundedMaterial(
    input.materials.adapterPackageBytes,
    "M7 Adapter package",
  );
  requireBoundedMaterial(
    input.materials.pristineConformanceReceiptBytes,
    "M7 pristine conformance receipt",
  );
  requireGenericPublicBytes(
    input.materials.observationSchemaBytes,
    "M7 public observation schema",
  );
  requireGenericPublicBytes(
    input.materials.classifierImplementationBytes,
    "M7 public classifier",
  );
  const basis = sensorFreezeBasis({
    schemaVersion: 1,
    pristineSubject: pristineSubjectSchema.parse(input.pristineSubject),
    sensor: frozenSensorIdentitySchema.parse({
      adapterRevisionId: input.adapterRevisionId,
      adapterPackageSha256: digest(input.materials.adapterPackageBytes),
      observationSchemaId: M7_PATROL_OBSERVATION_SCHEMA_ID_V1,
      observationSchemaSha256: digest(input.materials.observationSchemaBytes),
      classifierId: M7_PATROL_CLASSIFIER_ID_V1,
      classifierImplementationSha256: digest(
        input.materials.classifierImplementationBytes,
      ),
      pristineConformanceReceiptId: input.pristineConformanceReceiptId,
      pristineConformanceReceiptSha256: digest(
        input.materials.pristineConformanceReceiptBytes,
      ),
    }),
    frozenAt: timestampSchema.parse(input.frozenAt),
  });
  const recordSha256 = digestJson(basis);
  return deepFreeze(
    M7SensorFreezeRecordV1Schema.parse({
      ...basis,
      sensorFreezeId: `m7-sensor-freeze:${recordSha256.slice(0, 24)}`,
      recordSha256,
    }),
  );
};

const mutationBasis = (value: {
  readonly schemaVersion: 1;
  readonly sensorFreezeId: string;
  readonly mutationSha256: Sha256DigestV1;
  readonly mutationByteLength: number;
  readonly mutatedSourceId: z.infer<typeof SourceIdSchema>;
  readonly mutatedSelectedTreeSha256: Sha256DigestV1;
  readonly registeredAt: string;
}) => ({
  schemaVersion: value.schemaVersion,
  sensorFreezeId: value.sensorFreezeId,
  mutationSha256: value.mutationSha256,
  mutationByteLength: value.mutationByteLength,
  mutatedSourceId: value.mutatedSourceId,
  mutatedSelectedTreeSha256: value.mutatedSelectedTreeSha256,
  registeredAt: value.registeredAt,
});

export const M7HiddenMutationRegistrationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    mutationRegistrationId: mutationRegistrationIdSchema,
    sensorFreezeId: sensorFreezeIdSchema,
    mutationSha256: Sha256DigestV1Schema,
    mutationByteLength: z
      .number()
      .int()
      .min(1)
      .max(4 * 1024 * 1024),
    mutatedSourceId: SourceIdSchema,
    mutatedSelectedTreeSha256: Sha256DigestV1Schema,
    registeredAt: timestampSchema,
    recordSha256: Sha256DigestV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const expectedHash = digestJson(mutationBasis(value));
    if (value.recordSha256 !== expectedHash) {
      addHashMismatch(
        context,
        ["recordSha256"],
        "M7 mutation registration content hash does not match",
      );
    }
    if (
      value.mutationRegistrationId !==
      `m7-mutation:${expectedHash.slice(0, 24)}`
    ) {
      addHashMismatch(
        context,
        ["mutationRegistrationId"],
        "M7 mutation registration identity does not match its content",
      );
    }
  });
export type M7HiddenMutationRegistrationV1 = z.infer<
  typeof M7HiddenMutationRegistrationV1Schema
>;

const HIDDEN_MUTATION_TARGET_V1 =
  "components/enemy/storyvore_enemy.tscn" as const;

/** Host-only validator. The returned registration keeps these bytes opaque. */
export const assertExactM7HiddenMutationBytesV1 = (
  mutationBytes: string | Uint8Array,
): void => {
  const bytes =
    typeof mutationBytes === "string"
      ? new TextEncoder().encode(mutationBytes)
      : mutationBytes;
  if (bytes.byteLength < 1 || bytes.byteLength > 4 * 1024 * 1024) {
    throw new Error("M7 hidden mutation has an unsupported byte length");
  }
  const patch = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (patch.includes("\r")) {
    throw new Error("M7 hidden mutation must use canonical LF line endings");
  }
  const lines = patch.endsWith("\n")
    ? patch.slice(0, -1).split("\n")
    : patch.split("\n");
  const header = `diff --git a/${HIDDEN_MUTATION_TARGET_V1} b/${HIDDEN_MUTATION_TARGET_V1}`;
  if (
    lines.filter((line) => line.startsWith("diff --git ")).length !== 1 ||
    lines[0] !== header ||
    !lines.includes(`--- a/${HIDDEN_MUTATION_TARGET_V1}`) ||
    !lines.includes(`+++ b/${HIDDEN_MUTATION_TARGET_V1}`)
  ) {
    throw new Error("M7 hidden mutation must change only its registered file");
  }
  const changes = lines.filter(
    (line) =>
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---")),
  );
  const expectedChanges = [
    "-collision_mask = 5",
    "+collision_mask = 1",
    "-collision_mask = 5",
    "+collision_mask = 1",
  ];
  if (
    changes.length !== expectedChanges.length ||
    changes.some((line, index) => line !== expectedChanges[index]) ||
    !lines.some((line) =>
      /^ \[node name="LeftRay" type="RayCast2D" parent="\."/u.test(line),
    ) ||
    !lines.some((line) =>
      /^ \[node name="RightRay" type="RayCast2D" parent="\."/u.test(line),
    )
  ) {
    throw new Error(
      "M7 hidden mutation bytes do not match the single pre-registered mutation",
    );
  }
};

const assertFrozenMaterialHashes = (
  freeze: M7SensorFreezeRecordV1,
  materials: M7SensorMaterialBytesV1,
): void => {
  requireBoundedMaterial(materials.adapterPackageBytes, "M7 Adapter package");
  requireBoundedMaterial(
    materials.pristineConformanceReceiptBytes,
    "M7 pristine conformance receipt",
  );
  requireGenericPublicBytes(
    materials.observationSchemaBytes,
    "M7 public observation schema",
  );
  requireGenericPublicBytes(
    materials.classifierImplementationBytes,
    "M7 public classifier",
  );
  const observed = {
    adapterPackageSha256: digest(materials.adapterPackageBytes),
    observationSchemaSha256: digest(materials.observationSchemaBytes),
    classifierImplementationSha256: digest(
      materials.classifierImplementationBytes,
    ),
    pristineConformanceReceiptSha256: digest(
      materials.pristineConformanceReceiptBytes,
    ),
  };
  for (const [key, hash] of Object.entries(observed)) {
    if (hash !== freeze.sensor[key as keyof typeof observed]) {
      throw new Error(`M7 frozen sensor material changed: ${key}`);
    }
  }
};

export interface RegisterM7HiddenMutationV1Input {
  readonly schemaVersion: 1;
  readonly mutationBytes: string | Uint8Array;
  readonly mutatedSourceId: z.input<typeof SourceIdSchema>;
  readonly mutatedSelectedTreeSha256: z.input<typeof Sha256DigestV1Schema>;
  readonly sensorMaterials: M7SensorMaterialBytesV1;
  readonly registeredAt: string;
}

export interface M7SensorFreezeStoreV1 {
  createFreeze(
    input: CreateM7SensorFreezeRecordV1Input,
  ): M7SensorFreezeRecordV1;
  getFreeze(): M7SensorFreezeRecordV1 | undefined;
  registerMutation(
    input: RegisterM7HiddenMutationV1Input,
  ): M7HiddenMutationRegistrationV1;
  getMutation(): M7HiddenMutationRegistrationV1 | undefined;
  assertSensorMaterials(materials: M7SensorMaterialBytesV1): void;
}

/**
 * Create-once ordering authority used by the Host-only assignment store. The
 * mutation cannot exist until the generic sensor bytes have been frozen, and
 * registering it re-reads all four frozen byte identities.
 */
export const createM7SensorFreezeStoreV1 = (input?: {
  readonly freeze?: unknown;
  readonly mutation?: unknown;
}): M7SensorFreezeStoreV1 => {
  let freeze =
    input?.freeze === undefined
      ? undefined
      : deepFreeze(M7SensorFreezeRecordV1Schema.parse(input.freeze));
  let mutation =
    input?.mutation === undefined
      ? undefined
      : deepFreeze(M7HiddenMutationRegistrationV1Schema.parse(input.mutation));
  if (mutation !== undefined && freeze === undefined) {
    throw new Error("M7 mutation registration requires a sensor freeze");
  }
  if (
    mutation !== undefined &&
    freeze !== undefined &&
    mutation.sensorFreezeId !== freeze.sensorFreezeId
  ) {
    throw new Error(
      "M7 mutation registration references another sensor freeze",
    );
  }
  if (
    mutation !== undefined &&
    freeze !== undefined &&
    Date.parse(mutation.registeredAt) < Date.parse(freeze.frozenAt)
  ) {
    throw new Error("M7 mutation registration predates its sensor freeze");
  }

  return Object.freeze({
    createFreeze(
      createInput: CreateM7SensorFreezeRecordV1Input,
    ): M7SensorFreezeRecordV1 {
      if (freeze !== undefined) {
        throw new Error("M7 sensor freeze is create-once");
      }
      if (mutation !== undefined) {
        throw new Error("M7 mutation already exists before sensor freeze");
      }
      freeze = createM7SensorFreezeRecordV1(createInput);
      return freeze;
    },
    getFreeze: (): M7SensorFreezeRecordV1 | undefined => freeze,
    registerMutation(
      registerInput: RegisterM7HiddenMutationV1Input,
    ): M7HiddenMutationRegistrationV1 {
      if (freeze === undefined) {
        throw new Error(
          "M7 sensor must be frozen before mutation registration",
        );
      }
      if (mutation !== undefined) {
        throw new Error("M7 mutation registration is create-once");
      }
      assertFrozenMaterialHashes(freeze, registerInput.sensorMaterials);
      assertExactM7HiddenMutationBytesV1(registerInput.mutationBytes);
      const mutatedSourceId = SourceIdSchema.parse(
        registerInput.mutatedSourceId,
      );
      const mutatedSelectedTreeSha256 = Sha256DigestV1Schema.parse(
        registerInput.mutatedSelectedTreeSha256,
      );
      if (mutatedSourceId === freeze.pristineSubject.sourceId) {
        throw new Error(
          "M7 mutant must have a source identity distinct from pristine",
        );
      }
      if (
        mutatedSelectedTreeSha256 === freeze.pristineSubject.selectedTreeSha256
      ) {
        throw new Error("M7 mutation must change the selected source tree");
      }
      const registeredAt = timestampSchema.parse(registerInput.registeredAt);
      if (Date.parse(registeredAt) < Date.parse(freeze.frozenAt)) {
        throw new Error("M7 mutation cannot predate the sensor freeze");
      }
      const mutationBytes =
        typeof registerInput.mutationBytes === "string"
          ? new TextEncoder().encode(registerInput.mutationBytes)
          : registerInput.mutationBytes;
      const basis = mutationBasis({
        schemaVersion: 1,
        sensorFreezeId: freeze.sensorFreezeId,
        mutationSha256: digest(mutationBytes),
        mutationByteLength: mutationBytes.byteLength,
        mutatedSourceId,
        mutatedSelectedTreeSha256,
        registeredAt,
      });
      const recordSha256 = digestJson(basis);
      mutation = deepFreeze(
        M7HiddenMutationRegistrationV1Schema.parse({
          ...basis,
          mutationRegistrationId: `m7-mutation:${recordSha256.slice(0, 24)}`,
          recordSha256,
        }),
      );
      return mutation;
    },
    getMutation: (): M7HiddenMutationRegistrationV1 | undefined => mutation,
    assertSensorMaterials(materials: M7SensorMaterialBytesV1): void {
      if (freeze === undefined) {
        throw new Error("M7 sensor has not been frozen");
      }
      assertFrozenMaterialHashes(freeze, materials);
    },
  });
};

export const M7SensorAgentProjectionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    projectionKind: z.literal("m7-generic-patrol-sensor"),
    sensorFreezeId: sensorFreezeIdSchema,
    adapterRevisionId: ProjectAdapterRevisionIdSchema,
    adapterPackageSha256: Sha256DigestV1Schema,
    observationSchema: z
      .object({
        id: z.literal(M7_PATROL_OBSERVATION_SCHEMA_ID_V1),
        sha256: Sha256DigestV1Schema,
      })
      .strict(),
    classifier: z
      .object({
        id: z.literal(M7_PATROL_CLASSIFIER_ID_V1),
        sha256: Sha256DigestV1Schema,
      })
      .strict(),
    pristineConformanceReceiptId: AdapterConformanceReceiptIdSchema,
    pristineConformanceReceiptSha256: Sha256DigestV1Schema,
    projectionSha256: Sha256DigestV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const { projectionSha256, ...basis } = value;
    if (projectionSha256 !== digestJson(basis)) {
      addHashMismatch(
        context,
        ["projectionSha256"],
        "M7 Agent sensor projection hash does not match",
      );
    }
  });
export type M7SensorAgentProjectionV1 = z.infer<
  typeof M7SensorAgentProjectionV1Schema
>;

export const createM7SensorAgentProjectionV1 = (
  freezeInput: M7SensorFreezeRecordV1,
): M7SensorAgentProjectionV1 => {
  const freeze = M7SensorFreezeRecordV1Schema.parse(freezeInput);
  const basis = {
    schemaVersion: 1 as const,
    projectionKind: "m7-generic-patrol-sensor" as const,
    sensorFreezeId: freeze.sensorFreezeId,
    adapterRevisionId: freeze.sensor.adapterRevisionId,
    adapterPackageSha256: freeze.sensor.adapterPackageSha256,
    observationSchema: {
      id: freeze.sensor.observationSchemaId,
      sha256: freeze.sensor.observationSchemaSha256,
    },
    classifier: {
      id: freeze.sensor.classifierId,
      sha256: freeze.sensor.classifierImplementationSha256,
    },
    pristineConformanceReceiptId: freeze.sensor.pristineConformanceReceiptId,
    pristineConformanceReceiptSha256:
      freeze.sensor.pristineConformanceReceiptSha256,
  };
  return deepFreeze(
    M7SensorAgentProjectionV1Schema.parse({
      ...basis,
      projectionSha256: digestJson(basis),
    }),
  );
};

const scenarioClassSchema = z.enum([
  "public_reproduction",
  "hidden_variant",
  "regression_control",
]);
export type M7PatrolScenarioClassV1 = z.infer<typeof scenarioClassSchema>;

export const M7PatrolScenarioV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    scenarioId: z.string().regex(/^m7-scenario:[a-z_]+:[1-3]$/u),
    scenarioClass: scenarioClassSchema,
    repetition: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    startDirection: z.enum(["left", "right"]),
    platformProfile: z.enum(["standard", "narrow", "wide"]),
    speedScale: z.number().positive().max(4),
    fallOffEdge: z.boolean(),
    expectedMotion: z.enum([
      "reverses_and_remains_supported",
      "leaves_support_and_descends",
    ]),
  })
  .strict();
export type M7PatrolScenarioV1 = z.infer<typeof M7PatrolScenarioV1Schema>;

const scenario = (
  scenarioClass: M7PatrolScenarioClassV1,
  repetition: 1 | 2 | 3,
  input: Omit<
    M7PatrolScenarioV1,
    "schemaVersion" | "scenarioId" | "scenarioClass" | "repetition"
  >,
): M7PatrolScenarioV1 =>
  M7PatrolScenarioV1Schema.parse({
    schemaVersion: 1,
    scenarioId: `m7-scenario:${scenarioClass}:${repetition}`,
    scenarioClass,
    repetition,
    ...input,
  });

export const M7_PATROL_SCENARIO_PLAN_V1: readonly M7PatrolScenarioV1[] =
  deepFreeze([
    ...([1, 2, 3] as const).map((repetition) =>
      scenario("public_reproduction", repetition, {
        startDirection: "left",
        platformProfile: "standard",
        speedScale: 1,
        fallOffEdge: false,
        expectedMotion: "reverses_and_remains_supported",
      }),
    ),
    scenario("hidden_variant", 1, {
      startDirection: "right",
      platformProfile: "narrow",
      speedScale: 1,
      fallOffEdge: false,
      expectedMotion: "reverses_and_remains_supported",
    }),
    scenario("hidden_variant", 2, {
      startDirection: "right",
      platformProfile: "wide",
      speedScale: 1,
      fallOffEdge: false,
      expectedMotion: "reverses_and_remains_supported",
    }),
    scenario("hidden_variant", 3, {
      startDirection: "right",
      platformProfile: "standard",
      speedScale: 1.5,
      fallOffEdge: false,
      expectedMotion: "reverses_and_remains_supported",
    }),
    scenario("regression_control", 1, {
      startDirection: "left",
      platformProfile: "standard",
      speedScale: 1,
      fallOffEdge: true,
      expectedMotion: "leaves_support_and_descends",
    }),
    scenario("regression_control", 2, {
      startDirection: "right",
      platformProfile: "narrow",
      speedScale: 1,
      fallOffEdge: true,
      expectedMotion: "leaves_support_and_descends",
    }),
    scenario("regression_control", 3, {
      startDirection: "right",
      platformProfile: "wide",
      speedScale: 1.5,
      fallOffEdge: true,
      expectedMotion: "leaves_support_and_descends",
    }),
  ]);

export const M7_PATROL_SCENARIO_PLAN_SHA256_V1 = digestJson(
  M7_PATROL_SCENARIO_PLAN_V1,
);

export const M7PatrolPreflightRunReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    subject: z.enum(["pristine", "mutant"]),
    scenarioId: M7PatrolScenarioV1Schema.shape.scenarioId,
    observation: z.enum([
      "expected_motion_observed",
      "expected_motion_not_observed",
      "infrastructure_failure",
    ]),
    freshWorkspaceCreated: z.boolean(),
    freshImportCacheCreated: z.boolean(),
    freshProcessStarted: z.boolean(),
    agentLaunchCount: z.literal(0),
    observationSha256: Sha256DigestV1Schema.nullable(),
    cleanupProven: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.observation === "infrastructure_failure" &&
      value.observationSha256 !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["observationSha256"],
        message: "an infrastructure failure cannot claim an observation",
      });
    }
    if (
      value.observation !== "infrastructure_failure" &&
      value.observationSha256 === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["observationSha256"],
        message: "a completed preflight run requires an observation hash",
      });
    }
  });
export type M7PatrolPreflightRunReceiptV1 = z.infer<
  typeof M7PatrolPreflightRunReceiptV1Schema
>;

const preflightSummarySchema = z
  .object({
    plannedRunCount: z.literal(18),
    receivedRunCount: z.number().int().min(0).max(18),
    pristineExpectedMotionObserved: z.number().int().min(0).max(9),
    mutantPublicExpectedMotionObserved: z.number().int().min(0).max(3),
    mutantHiddenExpectedMotionObserved: z.number().int().min(0).max(3),
    mutantRegressionExpectedMotionObserved: z.number().int().min(0).max(3),
    infrastructureFailures: z.number().int().min(0).max(18),
    realizationFailures: z.number().int().min(0).max(18),
    cleanupFailures: z.number().int().min(0).max(18),
  })
  .strict();

const preflightBasis = (value: {
  readonly schemaVersion: 1;
  readonly sensorFreezeId: string;
  readonly mutationRegistrationId: string;
  readonly scenarioPlanSha256: Sha256DigestV1;
  readonly runs: readonly M7PatrolPreflightRunReceiptV1[];
  readonly summary: z.infer<typeof preflightSummarySchema>;
  readonly outcome: "passed" | "preflight_failed";
  readonly completedAt: string;
}) => ({
  schemaVersion: value.schemaVersion,
  sensorFreezeId: value.sensorFreezeId,
  mutationRegistrationId: value.mutationRegistrationId,
  scenarioPlanSha256: value.scenarioPlanSha256,
  runs: value.runs,
  summary: value.summary,
  outcome: value.outcome,
  completedAt: value.completedAt,
});

const summarizePreflight = (runs: readonly M7PatrolPreflightRunReceiptV1[]) => {
  const scenarioById = new Map(
    M7_PATROL_SCENARIO_PLAN_V1.map((entry) => [entry.scenarioId, entry]),
  );
  const seen = new Set<string>();
  let pristineExpectedMotionObserved = 0;
  let mutantPublicExpectedMotionObserved = 0;
  let mutantHiddenExpectedMotionObserved = 0;
  let mutantRegressionExpectedMotionObserved = 0;
  let infrastructureFailures = 0;
  let realizationFailures = 0;
  let cleanupFailures = 0;
  for (const run of runs) {
    const planned = scenarioById.get(run.scenarioId);
    if (planned === undefined) {
      throw new Error(
        `M7 preflight references an unplanned scenario: ${run.scenarioId}`,
      );
    }
    const key = `${run.subject}\0${run.scenarioId}`;
    if (seen.has(key)) {
      throw new Error(`M7 preflight repeats a subject/scenario run: ${key}`);
    }
    seen.add(key);
    if (run.observation === "infrastructure_failure") {
      infrastructureFailures += 1;
    }
    if (
      !run.freshWorkspaceCreated ||
      !run.freshImportCacheCreated ||
      !run.freshProcessStarted
    ) {
      realizationFailures += 1;
    }
    if (!run.cleanupProven) cleanupFailures += 1;
    if (run.observation !== "expected_motion_observed") continue;
    if (run.subject === "pristine") {
      pristineExpectedMotionObserved += 1;
    } else if (planned.scenarioClass === "public_reproduction") {
      mutantPublicExpectedMotionObserved += 1;
    } else if (planned.scenarioClass === "hidden_variant") {
      mutantHiddenExpectedMotionObserved += 1;
    } else {
      mutantRegressionExpectedMotionObserved += 1;
    }
  }
  return preflightSummarySchema.parse({
    plannedRunCount: 18,
    receivedRunCount: runs.length,
    pristineExpectedMotionObserved,
    mutantPublicExpectedMotionObserved,
    mutantHiddenExpectedMotionObserved,
    mutantRegressionExpectedMotionObserved,
    infrastructureFailures,
    realizationFailures,
    cleanupFailures,
  });
};

const preflightPassed = (summary: z.infer<typeof preflightSummarySchema>) =>
  summary.receivedRunCount === 18 &&
  summary.pristineExpectedMotionObserved === 9 &&
  summary.mutantPublicExpectedMotionObserved === 0 &&
  summary.mutantHiddenExpectedMotionObserved === 0 &&
  summary.mutantRegressionExpectedMotionObserved === 3 &&
  summary.infrastructureFailures === 0 &&
  summary.realizationFailures === 0 &&
  summary.cleanupFailures === 0;

export const M7PatrolPreflightResultV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    preflightResultId: preflightResultIdSchema,
    sensorFreezeId: sensorFreezeIdSchema,
    mutationRegistrationId: mutationRegistrationIdSchema,
    scenarioPlanSha256: Sha256DigestV1Schema,
    runs: z.array(M7PatrolPreflightRunReceiptV1Schema).max(18),
    summary: preflightSummarySchema,
    outcome: z.enum(["passed", "preflight_failed"]),
    completedAt: timestampSchema,
    recordSha256: Sha256DigestV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scenarioPlanSha256 !== M7_PATROL_SCENARIO_PLAN_SHA256_V1) {
      addHashMismatch(
        context,
        ["scenarioPlanSha256"],
        "M7 preflight scenario plan is not the frozen 3x3 plan",
      );
    }
    let expectedSummary: z.infer<typeof preflightSummarySchema>;
    try {
      expectedSummary = summarizePreflight(value.runs);
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["runs"],
        message:
          error instanceof Error ? error.message : "invalid M7 preflight runs",
      });
      return;
    }
    if (digestJson(value.summary) !== digestJson(expectedSummary)) {
      context.addIssue({
        code: "custom",
        path: ["summary"],
        message: "M7 preflight summary does not match its run receipts",
      });
    }
    const expectedOutcome = preflightPassed(expectedSummary)
      ? "passed"
      : "preflight_failed";
    if (value.outcome !== expectedOutcome) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "M7 preflight outcome does not match its frozen expectations",
      });
    }
    const expectedHash = digestJson(preflightBasis(value));
    if (value.recordSha256 !== expectedHash) {
      addHashMismatch(
        context,
        ["recordSha256"],
        "M7 preflight record content hash does not match",
      );
    }
    if (
      value.preflightResultId !== `m7-preflight:${expectedHash.slice(0, 24)}`
    ) {
      addHashMismatch(
        context,
        ["preflightResultId"],
        "M7 preflight identity does not match its content",
      );
    }
  });
export type M7PatrolPreflightResultV1 = z.infer<
  typeof M7PatrolPreflightResultV1Schema
>;

export const createM7PatrolPreflightResultV1 = (input: {
  readonly sensorFreezeId: string;
  readonly mutationRegistrationId: string;
  readonly runs: readonly M7PatrolPreflightRunReceiptV1[];
  readonly completedAt: string;
}): M7PatrolPreflightResultV1 => {
  const runs = input.runs.map((run) =>
    M7PatrolPreflightRunReceiptV1Schema.parse(run),
  );
  const summary = summarizePreflight(runs);
  const basis = preflightBasis({
    schemaVersion: 1,
    sensorFreezeId: sensorFreezeIdSchema.parse(input.sensorFreezeId),
    mutationRegistrationId: mutationRegistrationIdSchema.parse(
      input.mutationRegistrationId,
    ),
    scenarioPlanSha256: M7_PATROL_SCENARIO_PLAN_SHA256_V1,
    runs,
    summary,
    outcome: preflightPassed(summary) ? "passed" : "preflight_failed",
    completedAt: timestampSchema.parse(input.completedAt),
  });
  const recordSha256 = digestJson(basis);
  return deepFreeze(
    M7PatrolPreflightResultV1Schema.parse({
      ...basis,
      preflightResultId: `m7-preflight:${recordSha256.slice(0, 24)}`,
      recordSha256,
    }),
  );
};
