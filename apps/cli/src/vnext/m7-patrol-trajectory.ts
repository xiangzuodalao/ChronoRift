import {
  AdapterCompatibilityReceiptIdSchema,
  BuildIdSchema,
  ExecutionIdSchema,
  JsonValueSchema,
  ProjectAdapterRevisionIdSchema,
  RuntimeIdSchema,
  Sha256DigestV1Schema,
  SourceIdSchema,
  TaskIdSchema,
  asSha256DigestV1,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson, contentHash } from "@chronorift/json-artifacts";
import { z } from "zod";

import {
  M7PatrolEntityStateV1Schema,
  M7PatrolStateTimelineV1Schema,
  type M7PatrolEntityStateV1,
  type M7PatrolStateTimelineV1,
} from "./m7-patrol-sensor.js";

export const M7_PATROL_TRAJECTORY_CLASSIFIER_ID_V1 =
  "chronorift.generic-patrol-trajectory.v1" as const;

export const M7_PATROL_TRAJECTORY_WITNESS_KINDS_V1 = [
  "ground_contact_loss",
  "grounded_speed_deviation",
  "grounded_stall",
  "direction_recovery",
  "sustained_grounded_motion",
] as const;

const witnessKindSchema = z.enum(M7_PATROL_TRAJECTORY_WITNESS_KINDS_V1);
const timestampSchema = z.string().datetime({ offset: true });
const nonnegativeSafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const positiveSafeIntegerSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);
const opaqueIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u)
  .refine((value) => !value.includes(".."));
const toolNameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const campaignIdSchema = z.string().regex(/^m7-campaign:[a-f0-9]{24}$/u);
const caseIdSchema = z.string().regex(/^m7-r3-trajectory-case:[a-f0-9]{24}$/u);

const hashJson = (value: unknown): Sha256DigestV1 =>
  asSha256DigestV1(contentHash(JsonValueSchema.parse(value)));

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

const classifierConfigBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    stateDomainId: z.literal("patrol.motion"),
    classifierId: z.literal(M7_PATROL_TRAJECTORY_CLASSIFIER_ID_V1),
    groundedStallAbsoluteSpeedRatioMaximum: z
      .number()
      .finite()
      .nonnegative()
      .max(1),
    expectedGroundedAbsoluteSpeedRatioMinimum: z
      .number()
      .finite()
      .positive()
      .max(4),
    expectedGroundedAbsoluteSpeedRatioMaximum: z
      .number()
      .finite()
      .positive()
      .max(8),
    sustainedGroundedSampleCountMinimum: z.number().int().min(3).max(1_000),
    retainedWitnessMaximum: z.number().int().min(1).max(100_000),
  })
  .strict();

export const M7PatrolTrajectoryClassifierConfigV1Schema =
  classifierConfigBasisSchema
    .extend({ configSha256: Sha256DigestV1Schema })
    .strict()
    .superRefine((value, context) => {
      if (
        value.groundedStallAbsoluteSpeedRatioMaximum >=
          value.expectedGroundedAbsoluteSpeedRatioMinimum ||
        value.expectedGroundedAbsoluteSpeedRatioMinimum >=
          value.expectedGroundedAbsoluteSpeedRatioMaximum
      ) {
        addIssue(
          context,
          ["expectedGroundedAbsoluteSpeedRatioMinimum"],
          "trajectory speed bands must be strictly ordered",
        );
      }
      const { configSha256, ...basis } = value;
      if (configSha256 !== hashJson(basis)) {
        addIssue(
          context,
          ["configSha256"],
          "trajectory classifier config hash does not match",
        );
      }
    });
export type M7PatrolTrajectoryClassifierConfigV1 = z.infer<
  typeof M7PatrolTrajectoryClassifierConfigV1Schema
>;

export const createM7PatrolTrajectoryClassifierConfigV1 = (
  input: z.input<typeof classifierConfigBasisSchema>,
): M7PatrolTrajectoryClassifierConfigV1 => {
  const basis = classifierConfigBasisSchema.parse(input);
  return deepFreeze(
    M7PatrolTrajectoryClassifierConfigV1Schema.parse({
      ...basis,
      configSha256: hashJson(basis),
    }),
  );
};

/**
 * Frozen generic motion thresholds. They refer only to the public
 * `patrol.motion` vocabulary and are independent of any later case change or
 * source implementation.
 */
export const M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1 =
  createM7PatrolTrajectoryClassifierConfigV1({
    schemaVersion: 1,
    stateDomainId: "patrol.motion",
    classifierId: M7_PATROL_TRAJECTORY_CLASSIFIER_ID_V1,
    groundedStallAbsoluteSpeedRatioMaximum: 0.1,
    expectedGroundedAbsoluteSpeedRatioMinimum: 0.5,
    expectedGroundedAbsoluteSpeedRatioMaximum: 1.5,
    sustainedGroundedSampleCountMinimum: 3,
    retainedWitnessMaximum: 100_000,
  });

export const M7PatrolTrajectoryWitnessKindV1Schema = witnessKindSchema;
export type M7PatrolTrajectoryWitnessKindV1 = z.infer<
  typeof M7PatrolTrajectoryWitnessKindV1Schema
>;

const trajectoryWitnessBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    stateDomainId: z.literal("patrol.motion"),
    kind: witnessKindSchema,
    entityId: opaqueIdSchema,
    name: z.string().min(1).max(512),
    fallOffEdge: z.boolean(),
    firstSampleOrdinal: nonnegativeSafeIntegerSchema,
    lastSampleOrdinal: nonnegativeSafeIntegerSchema,
    observedSampleCount: z.number().int().min(2).max(100_000),
    configuredSpeed: z.number().finite().nonnegative(),
    minimumObservedAbsoluteSpeedRatio: z
      .number()
      .finite()
      .nonnegative()
      .nullable(),
    maximumObservedAbsoluteSpeedRatio: z
      .number()
      .finite()
      .nonnegative()
      .nullable(),
    fromState: M7PatrolEntityStateV1Schema,
    toState: M7PatrolEntityStateV1Schema,
  })
  .strict();

export const M7PatrolTrajectoryWitnessV1Schema = trajectoryWitnessBasisSchema
  .extend({ witnessSha256: Sha256DigestV1Schema })
  .strict()
  .superRefine((value, context) => {
    if (value.lastSampleOrdinal <= value.firstSampleOrdinal) {
      addIssue(
        context,
        ["lastSampleOrdinal"],
        "a trajectory witness must span at least two samples",
      );
    }
    for (const [field, state] of [
      ["fromState", value.fromState],
      ["toState", value.toState],
    ] as const) {
      if (
        state.entity_id !== value.entityId ||
        state.name !== value.name ||
        state.fall_off_edge !== value.fallOffEdge ||
        state.speed !== value.configuredSpeed
      ) {
        addIssue(
          context,
          [field],
          "trajectory witness state does not match its public entity identity and configuration",
        );
      }
    }
    const ratiosAreNull =
      value.minimumObservedAbsoluteSpeedRatio === null &&
      value.maximumObservedAbsoluteSpeedRatio === null;
    if (
      ratiosAreNull !== (value.configuredSpeed === 0) ||
      (value.minimumObservedAbsoluteSpeedRatio !== null &&
        value.maximumObservedAbsoluteSpeedRatio !== null &&
        value.minimumObservedAbsoluteSpeedRatio >
          value.maximumObservedAbsoluteSpeedRatio)
    ) {
      addIssue(
        context,
        ["minimumObservedAbsoluteSpeedRatio"],
        "trajectory witness speed ratios do not match configured speed",
      );
    }
    const { witnessSha256, ...basis } = value;
    if (witnessSha256 !== hashJson(basis)) {
      addIssue(
        context,
        ["witnessSha256"],
        "trajectory witness hash does not match",
      );
    }
  });
export type M7PatrolTrajectoryWitnessV1 = z.infer<
  typeof M7PatrolTrajectoryWitnessV1Schema
>;

const classificationBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    stateDomainId: z.literal("patrol.motion"),
    classifierId: z.literal(M7_PATROL_TRAJECTORY_CLASSIFIER_ID_V1),
    classifierConfig: M7PatrolTrajectoryClassifierConfigV1Schema,
    classifierInput: M7PatrolStateTimelineV1Schema,
    classifierInputSha256: Sha256DigestV1Schema,
    retainedWitnessCount: nonnegativeSafeIntegerSchema,
    omittedWitnessCount: nonnegativeSafeIntegerSchema,
    classifierLossObserved: z.boolean(),
    witnesses: z.array(M7PatrolTrajectoryWitnessV1Schema).max(100_000),
  })
  .strict();

type Observation = {
  readonly ordinal: number;
  readonly state: M7PatrolEntityStateV1;
};

const speedRatio = (state: M7PatrolEntityStateV1): number | null =>
  state.speed === 0 ? null : Math.abs(state.velocity_x) / state.speed;

const stateMovesAsDeclared = (
  state: M7PatrolEntityStateV1,
  config: M7PatrolTrajectoryClassifierConfigV1,
): boolean => {
  const ratio = speedRatio(state);
  return (
    state.grounded &&
    ratio !== null &&
    ratio >= config.expectedGroundedAbsoluteSpeedRatioMinimum &&
    ratio <= config.expectedGroundedAbsoluteSpeedRatioMaximum &&
    Math.sign(state.velocity_x) === state.direction
  );
};

const createWitness = (input: {
  readonly kind: M7PatrolTrajectoryWitnessKindV1;
  readonly observations: readonly Observation[];
}): M7PatrolTrajectoryWitnessV1 => {
  const first = input.observations[0];
  const last = input.observations.at(-1);
  if (
    first === undefined ||
    last === undefined ||
    input.observations.length < 2
  ) {
    throw new TypeError(
      "trajectory witness requires at least two observations",
    );
  }
  const ratios = input.observations
    .map(({ state }) => speedRatio(state))
    .filter((ratio) => ratio !== null);
  const ratioRange = ratios.reduce<{
    readonly minimum: number;
    readonly maximum: number;
  } | null>(
    (range, ratio) =>
      range === null
        ? { minimum: ratio, maximum: ratio }
        : {
            minimum: Math.min(range.minimum, ratio),
            maximum: Math.max(range.maximum, ratio),
          },
    null,
  );
  const basis = trajectoryWitnessBasisSchema.parse({
    schemaVersion: 1,
    stateDomainId: "patrol.motion",
    kind: input.kind,
    entityId: first.state.entity_id,
    name: first.state.name,
    fallOffEdge: first.state.fall_off_edge,
    firstSampleOrdinal: first.ordinal,
    lastSampleOrdinal: last.ordinal,
    observedSampleCount: input.observations.length,
    configuredSpeed: first.state.speed,
    minimumObservedAbsoluteSpeedRatio:
      ratioRange === null ? null : ratioRange.minimum,
    maximumObservedAbsoluteSpeedRatio:
      ratioRange === null ? null : ratioRange.maximum,
    fromState: first.state,
    toState: last.state,
  });
  return M7PatrolTrajectoryWitnessV1Schema.parse({
    ...basis,
    witnessSha256: hashJson(basis),
  });
};

interface WitnessCollector {
  readonly witnesses: M7PatrolTrajectoryWitnessV1[];
  omittedWitnessCount: number;
  add(witness: M7PatrolTrajectoryWitnessV1): void;
}

const createWitnessCollector = (retainedMaximum: number): WitnessCollector => {
  const collector: WitnessCollector = {
    witnesses: [],
    omittedWitnessCount: 0,
    add(witness): void {
      if (collector.witnesses.length < retainedMaximum) {
        collector.witnesses.push(witness);
      } else {
        collector.omittedWitnessCount += 1;
      }
    },
  };
  return collector;
};

const maximalRuns = (
  observations: readonly Observation[],
  predicate: (observation: Observation) => boolean,
  compatible: (left: Observation, right: Observation) => boolean = () => true,
): readonly (readonly Observation[])[] => {
  const runs: Observation[][] = [];
  let current: Observation[] = [];
  for (const observation of observations) {
    const previous = current.at(-1);
    if (
      predicate(observation) &&
      (previous === undefined || compatible(previous, observation))
    ) {
      current.push(observation);
      continue;
    }
    if (current.length > 0) runs.push(current);
    current = predicate(observation) ? [observation] : [];
  }
  if (current.length > 0) runs.push(current);
  return runs;
};

const collectKindWitnesses = (input: {
  readonly kind: M7PatrolTrajectoryWitnessKindV1;
  readonly observations: readonly Observation[];
  readonly config: M7PatrolTrajectoryClassifierConfigV1;
  readonly collector: WitnessCollector;
}): void => {
  const { kind, observations, config, collector } = input;
  if (kind === "ground_contact_loss") {
    for (let index = 1; index < observations.length; index += 1) {
      const previous = observations[index - 1];
      const current = observations[index];
      if (
        previous?.state.grounded &&
        current !== undefined &&
        !current.state.grounded
      ) {
        collector.add(
          createWitness({ kind, observations: [previous, current] }),
        );
      }
    }
    return;
  }
  if (kind === "grounded_speed_deviation") {
    for (let index = 1; index < observations.length; index += 1) {
      const previous = observations[index - 1];
      const current = observations[index];
      if (
        previous === undefined ||
        current === undefined ||
        !previous.state.grounded ||
        !current.state.grounded
      )
        continue;
      const ratio = speedRatio(current.state);
      if (
        ratio !== null &&
        ratio > config.groundedStallAbsoluteSpeedRatioMaximum &&
        (ratio < config.expectedGroundedAbsoluteSpeedRatioMinimum ||
          ratio > config.expectedGroundedAbsoluteSpeedRatioMaximum)
      ) {
        collector.add(
          createWitness({ kind, observations: [previous, current] }),
        );
      }
    }
    return;
  }
  if (kind === "grounded_stall") {
    for (const run of maximalRuns(observations, ({ state }) => {
      const ratio = speedRatio(state);
      return (
        state.grounded &&
        ratio !== null &&
        ratio <= config.groundedStallAbsoluteSpeedRatioMaximum
      );
    })) {
      if (run.length >= 2)
        collector.add(createWitness({ kind, observations: run }));
    }
    return;
  }
  if (kind === "direction_recovery") {
    for (let index = 1; index < observations.length; index += 1) {
      const previous = observations[index - 1];
      const current = observations[index];
      if (
        previous !== undefined &&
        current !== undefined &&
        previous.state.grounded &&
        current.state.grounded &&
        previous.state.direction === -current.state.direction &&
        stateMovesAsDeclared(current.state, config)
      ) {
        collector.add(
          createWitness({ kind, observations: [previous, current] }),
        );
      }
    }
    return;
  }
  for (const run of maximalRuns(
    observations,
    ({ state }) => stateMovesAsDeclared(state, config),
    (left, right) => left.state.direction === right.state.direction,
  )) {
    if (run.length >= config.sustainedGroundedSampleCountMinimum) {
      collector.add(createWitness({ kind, observations: run }));
    }
  }
};

const deriveClassificationBasis = (
  timeline: M7PatrolStateTimelineV1,
  config: M7PatrolTrajectoryClassifierConfigV1,
): z.infer<typeof classificationBasisSchema> => {
  const byEntity = new Map<string, Observation[]>();
  for (const frame of timeline.frames) {
    for (const state of frame.entities) {
      const observations = byEntity.get(state.entity_id) ?? [];
      observations.push({ ordinal: frame.sample_ordinal, state });
      byEntity.set(state.entity_id, observations);
    }
  }
  const collector = createWitnessCollector(config.retainedWitnessMaximum);
  for (const entityId of [...byEntity.keys()].sort((left, right) =>
    left.localeCompare(right, "en"),
  )) {
    const observations = byEntity.get(entityId) ?? [];
    for (const kind of M7_PATROL_TRAJECTORY_WITNESS_KINDS_V1) {
      collectKindWitnesses({ kind, observations, config, collector });
    }
  }
  return classificationBasisSchema.parse({
    schemaVersion: 1,
    stateDomainId: "patrol.motion",
    classifierId: M7_PATROL_TRAJECTORY_CLASSIFIER_ID_V1,
    classifierConfig: config,
    classifierInput: timeline,
    classifierInputSha256: hashJson(timeline),
    retainedWitnessCount: collector.witnesses.length,
    omittedWitnessCount: collector.omittedWitnessCount,
    classifierLossObserved: collector.omittedWitnessCount > 0,
    witnesses: collector.witnesses,
  });
};

export const M7PatrolTrajectoryClassificationV1Schema =
  classificationBasisSchema
    .extend({ classificationOutputSha256: Sha256DigestV1Schema })
    .strict()
    .superRefine((value, context) => {
      if (value.classifierInputSha256 !== hashJson(value.classifierInput)) {
        addIssue(
          context,
          ["classifierInputSha256"],
          "trajectory classifier input hash does not match",
        );
      }
      const parsedConfig = M7PatrolTrajectoryClassifierConfigV1Schema.safeParse(
        value.classifierConfig,
      );
      const parsedInput = M7PatrolStateTimelineV1Schema.safeParse(
        value.classifierInput,
      );
      if (!parsedConfig.success || !parsedInput.success) return;
      const expected = deriveClassificationBasis(
        parsedInput.data,
        parsedConfig.data,
      );
      const { classificationOutputSha256, ...basis } = value;
      if (!sameJson(basis, expected)) {
        addIssue(
          context,
          ["witnesses"],
          "trajectory classification does not derive from public patrol.motion rows",
        );
      }
      if (classificationOutputSha256 !== hashJson(basis)) {
        addIssue(
          context,
          ["classificationOutputSha256"],
          "trajectory classification output hash does not match",
        );
      }
    });
export type M7PatrolTrajectoryClassificationV1 = z.infer<
  typeof M7PatrolTrajectoryClassificationV1Schema
>;

export const classifyM7PatrolTrajectoryV1 = (input: {
  readonly timeline: M7PatrolStateTimelineV1;
  readonly config?: M7PatrolTrajectoryClassifierConfigV1;
}): M7PatrolTrajectoryClassificationV1 => {
  const timeline = M7PatrolStateTimelineV1Schema.parse(input.timeline);
  const config = M7PatrolTrajectoryClassifierConfigV1Schema.parse(
    input.config ?? M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1,
  );
  const basis = deriveClassificationBasis(timeline, config);
  return deepFreeze(
    M7PatrolTrajectoryClassificationV1Schema.parse({
      ...basis,
      classificationOutputSha256: hashJson(basis),
    }),
  );
};

export const M7R3HostObservedSourceChangeBoundaryV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    hostToolReturnOrdinal: positiveSafeIntegerSchema,
    sourceChangingToolIssuedInAgentTurnOrdinal: positiveSafeIntegerSchema,
    boundary: z.enum(["coding_tool_return", "game_build_freeze"]),
    sourceSha256: Sha256DigestV1Schema,
    buildId: BuildIdSchema.nullable(),
    observedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.boundary === "game_build_freeze") !== (value.buildId !== null)) {
      addIssue(
        context,
        ["buildId"],
        "only a game Build-freeze boundary carries a Build identity",
      );
    }
  });
export type M7R3HostObservedSourceChangeBoundaryV1 = z.infer<
  typeof M7R3HostObservedSourceChangeBoundaryV1Schema
>;

const trajectoryLineageSchema = z
  .object({
    taskId: TaskIdSchema,
    executionId: ExecutionIdSchema,
    runtimeId: RuntimeIdSchema,
    buildId: BuildIdSchema,
    sourceId: SourceIdSchema,
    sourceSha256: Sha256DigestV1Schema,
    adapterRevisionId: ProjectAdapterRevisionIdSchema,
    adapterCompatibilityReceiptId: AdapterCompatibilityReceiptIdSchema,
    adapterCompatibilityReceiptSha256: Sha256DigestV1Schema,
  })
  .strict();

const trajectoryCoverageSchema = z
  .object({
    complete: z.boolean(),
    observedFrameCount: z.number().int().min(2).max(100_000),
    observedEntitySampleCount: positiveSafeIntegerSchema,
    firstSampleOrdinal: nonnegativeSafeIntegerSchema,
    lastSampleOrdinal: nonnegativeSafeIntegerSchema,
    coverageReceiptSha256: Sha256DigestV1Schema,
  })
  .strict();

const trajectoryLossSchema = z
  .object({
    historyLossObserved: z.boolean(),
    droppedRecordCount: nonnegativeSafeIntegerSchema,
    overwrittenRecordCount: nonnegativeSafeIntegerSchema,
    unavailableHistoryObserved: z.boolean(),
    lossReceiptSha256: Sha256DigestV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const expected =
      value.droppedRecordCount > 0 ||
      value.overwrittenRecordCount > 0 ||
      value.unavailableHistoryObserved;
    if (value.historyLossObserved !== expected) {
      addIssue(
        context,
        ["historyLossObserved"],
        "trajectory history-loss flag does not match retained loss facts",
      );
    }
  });

const trajectoryCleanupSchema = z
  .object({
    proven: z.boolean(),
    cleanupReceiptSha256: Sha256DigestV1Schema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.proven !== (value.cleanupReceiptSha256 !== null)) {
      addIssue(
        context,
        ["cleanupReceiptSha256"],
        "trajectory cleanup proof requires exactly one receipt hash",
      );
    }
  });

/**
 * Durable match to Pi's final `tool_execution_end` event. A game-wrapper
 * return by itself is not evidence that Pi delivered the ToolResult to the
 * Agent; the final result hash and call identity must be observed on Pi's
 * event stream and bound to the same Host return ordinal.
 */
export const M7R3AgentVisibleFinalToolResultV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    eventType: z.literal("tool_execution_end"),
    resultProjectionKind: z.literal("json-roundtrip-v1"),
    piEventOrdinal: positiveSafeIntegerSchema,
    toolResultProducedInAgentTurnOrdinal: positiveSafeIntegerSchema,
    availableToModelAtAgentTurnOrdinal: positiveSafeIntegerSchema,
    toolCallId: opaqueIdSchema,
    toolName: toolNameSchema,
    hostToolReturnOrdinal: positiveSafeIntegerSchema,
    finalResultSha256: Sha256DigestV1Schema,
    finalResultDetailsSha256: Sha256DigestV1Schema,
    eventReceiptSha256: Sha256DigestV1Schema,
    modelAvailabilityReceiptSha256: Sha256DigestV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.availableToModelAtAgentTurnOrdinal <=
      value.toolResultProducedInAgentTurnOrdinal
    ) {
      addIssue(
        context,
        ["availableToModelAtAgentTurnOrdinal"],
        "a final ToolResult becomes model-visible only at a later observed Agent turn",
      );
    }
  });
export type M7R3AgentVisibleFinalToolResultV1 = z.infer<
  typeof M7R3AgentVisibleFinalToolResultV1Schema
>;

const executionSummaryBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-patrol-trajectory-execution-summary"),
    lineage: trajectoryLineageSchema,
    startedAt: timestampSchema,
    endedAt: timestampSchema,
    sealed: z.literal(true),
    executionSealSha256: Sha256DigestV1Schema,
    runtimeObservationReceiptSha256: Sha256DigestV1Schema,
    classifierImplementationSha256: Sha256DigestV1Schema,
    classification: M7PatrolTrajectoryClassificationV1Schema,
    agentVisibleAtHostToolReturnOrdinal: positiveSafeIntegerSchema,
    agentVisibleExchangeTranscriptSha256: Sha256DigestV1Schema,
    agentVisibleExchangeReceiptSha256: Sha256DigestV1Schema,
    agentVisibleDeliveryResponseSha256: Sha256DigestV1Schema,
    agentVisibleResponseDetailsSha256: Sha256DigestV1Schema,
    agentVisibleFinalToolResult: M7R3AgentVisibleFinalToolResultV1Schema,
    firstHostObservedSourceChange:
      M7R3HostObservedSourceChangeBoundaryV1Schema.nullable(),
    coverage: trajectoryCoverageSchema,
    loss: trajectoryLossSchema,
    cleanup: trajectoryCleanupSchema,
  })
  .strict();

export const M7R3PatrolTrajectoryExecutionSummaryV1Schema =
  executionSummaryBasisSchema
    .extend({ summarySha256: Sha256DigestV1Schema })
    .strict()
    .superRefine((value, context) => {
      if (Date.parse(value.endedAt) < Date.parse(value.startedAt)) {
        addIssue(
          context,
          ["endedAt"],
          "trajectory execution cannot end before it starts",
        );
      }
      const timeline = value.classification.classifierInput;
      if (timeline.execution_id !== value.lineage.executionId) {
        addIssue(
          context,
          ["classification", "classifierInput", "execution_id"],
          "trajectory input must retain its execution lineage",
        );
      }
      const observedEntitySampleCount = timeline.frames.reduce(
        (count, frame) => count + frame.entities.length,
        0,
      );
      if (
        value.coverage.observedFrameCount !== timeline.frames.length ||
        value.coverage.observedEntitySampleCount !==
          observedEntitySampleCount ||
        value.coverage.firstSampleOrdinal !==
          timeline.frames[0]?.sample_ordinal ||
        value.coverage.lastSampleOrdinal !==
          timeline.frames.at(-1)?.sample_ordinal
      ) {
        addIssue(
          context,
          ["coverage"],
          "trajectory coverage counts must match the retained patrol.motion rows",
        );
      }
      if (
        value.coverage.complete &&
        (value.loss.historyLossObserved ||
          value.classification.classifierLossObserved)
      ) {
        addIssue(
          context,
          ["coverage", "complete"],
          "complete trajectory coverage cannot retain history or classifier loss",
        );
      }
      if (
        value.agentVisibleFinalToolResult.hostToolReturnOrdinal !==
          value.agentVisibleAtHostToolReturnOrdinal ||
        value.agentVisibleFinalToolResult.finalResultSha256 !==
          value.agentVisibleDeliveryResponseSha256 ||
        value.agentVisibleFinalToolResult.finalResultDetailsSha256 !==
          value.agentVisibleResponseDetailsSha256
      ) {
        addIssue(
          context,
          ["agentVisibleFinalToolResult"],
          "Agent-visible trajectory delivery must match Pi's final ToolResult event",
        );
      }
      const { summarySha256, ...basis } = value;
      if (summarySha256 !== hashJson(basis)) {
        addIssue(
          context,
          ["summarySha256"],
          "trajectory execution summary hash does not match",
        );
      }
    });
export type M7R3PatrolTrajectoryExecutionSummaryV1 = z.infer<
  typeof M7R3PatrolTrajectoryExecutionSummaryV1Schema
>;

export interface CreateM7R3PatrolTrajectoryExecutionSummaryV1Input {
  readonly lineage: z.input<typeof trajectoryLineageSchema>;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly executionSealSha256: Sha256DigestV1;
  readonly runtimeObservationReceiptSha256: Sha256DigestV1;
  readonly classifierImplementationSha256: Sha256DigestV1;
  readonly classifierConfig?: M7PatrolTrajectoryClassifierConfigV1;
  readonly agentVisibleTimeline: M7PatrolStateTimelineV1;
  readonly agentVisibleAtHostToolReturnOrdinal: number;
  readonly agentVisibleExchangeTranscriptSha256: Sha256DigestV1;
  readonly agentVisibleExchangeReceiptSha256: Sha256DigestV1;
  readonly agentVisibleDeliveryResponseSha256: Sha256DigestV1;
  readonly agentVisibleResponseDetailsSha256: Sha256DigestV1;
  readonly agentVisibleFinalToolResult: M7R3AgentVisibleFinalToolResultV1;
  readonly firstHostObservedSourceChange: M7R3HostObservedSourceChangeBoundaryV1 | null;
  readonly coverageComplete: boolean;
  readonly coverageReceiptSha256: Sha256DigestV1;
  readonly loss: z.input<typeof trajectoryLossSchema>;
  readonly cleanup: z.input<typeof trajectoryCleanupSchema>;
}

/**
 * Creates a summary only from a delivery already confirmed by Pi's `onEvent`
 * stream. Callers must not synthesize `agentVisibleFinalToolResult` from the
 * game-wrapper return capture.
 */
export const createM7R3PatrolTrajectoryExecutionSummaryV1 = (
  input: CreateM7R3PatrolTrajectoryExecutionSummaryV1Input,
): M7R3PatrolTrajectoryExecutionSummaryV1 => {
  const classification = classifyM7PatrolTrajectoryV1({
    timeline: input.agentVisibleTimeline,
    ...(input.classifierConfig === undefined
      ? {}
      : { config: input.classifierConfig }),
  });
  const frames = classification.classifierInput.frames;
  const basis = executionSummaryBasisSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-r3-patrol-trajectory-execution-summary",
    lineage: input.lineage,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    sealed: true,
    executionSealSha256: input.executionSealSha256,
    runtimeObservationReceiptSha256: input.runtimeObservationReceiptSha256,
    classifierImplementationSha256: input.classifierImplementationSha256,
    classification,
    agentVisibleAtHostToolReturnOrdinal:
      input.agentVisibleAtHostToolReturnOrdinal,
    agentVisibleExchangeTranscriptSha256:
      input.agentVisibleExchangeTranscriptSha256,
    agentVisibleExchangeReceiptSha256: input.agentVisibleExchangeReceiptSha256,
    agentVisibleDeliveryResponseSha256:
      input.agentVisibleDeliveryResponseSha256,
    agentVisibleResponseDetailsSha256:
      input.agentVisibleResponseDetailsSha256,
    agentVisibleFinalToolResult: input.agentVisibleFinalToolResult,
    firstHostObservedSourceChange: input.firstHostObservedSourceChange,
    coverage: {
      complete: input.coverageComplete,
      observedFrameCount: frames.length,
      observedEntitySampleCount: frames.reduce(
        (count, frame) => count + frame.entities.length,
        0,
      ),
      firstSampleOrdinal: frames[0]?.sample_ordinal,
      lastSampleOrdinal: frames.at(-1)?.sample_ordinal,
      coverageReceiptSha256: input.coverageReceiptSha256,
    },
    loss: input.loss,
    cleanup: input.cleanup,
  });
  return deepFreeze(
    M7R3PatrolTrajectoryExecutionSummaryV1Schema.parse({
      ...basis,
      summarySha256: hashJson(basis),
    }),
  );
};

const orderedWitnessKindsSchema = z
  .array(witnessKindSchema)
  .min(1)
  .max(M7_PATROL_TRAJECTORY_WITNESS_KINDS_V1.length)
  .superRefine((value, context) => {
    const expected = M7_PATROL_TRAJECTORY_WITNESS_KINDS_V1.filter((kind) =>
      value.includes(kind),
    );
    if (new Set(value).size !== value.length || !sameJson(value, expected)) {
      addIssue(
        context,
        [],
        "expected trajectory witness kinds must be unique and canonically ordered",
      );
    }
  });

const caseSpecBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-patrol-trajectory-case-spec"),
    classifierId: z.literal(M7_PATROL_TRAJECTORY_CLASSIFIER_ID_V1),
    classifierImplementationSha256: Sha256DigestV1Schema,
    classifierConfigSha256: Sha256DigestV1Schema,
    expectedBaselineWitnessKinds: orderedWitnessKindsSchema,
    expectedRecoveryWitnessKinds: orderedWitnessKindsSchema,
    frozenAt: timestampSchema,
  })
  .strict();

export const M7R3PatrolTrajectoryCaseSpecV1Schema = caseSpecBasisSchema
  .extend({
    caseId: caseIdSchema,
    caseSpecSha256: Sha256DigestV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const { caseId, caseSpecSha256, ...basis } = value;
    const expectedHash = hashJson(basis);
    if (caseSpecSha256 !== expectedHash) {
      addIssue(
        context,
        ["caseSpecSha256"],
        "trajectory case-spec hash does not match",
      );
    }
    if (caseId !== `m7-r3-trajectory-case:${expectedHash.slice(0, 24)}`) {
      addIssue(
        context,
        ["caseId"],
        "trajectory case ID does not derive from the pre-registered generic expectations",
      );
    }
  });
export type M7R3PatrolTrajectoryCaseSpecV1 = z.infer<
  typeof M7R3PatrolTrajectoryCaseSpecV1Schema
>;

export const createM7R3PatrolTrajectoryCaseSpecV1 = (input: {
  readonly classifierImplementationSha256: Sha256DigestV1;
  readonly classifierConfigSha256?: Sha256DigestV1;
  readonly expectedBaselineWitnessKinds: readonly M7PatrolTrajectoryWitnessKindV1[];
  readonly expectedRecoveryWitnessKinds: readonly M7PatrolTrajectoryWitnessKindV1[];
  readonly frozenAt: string;
}): M7R3PatrolTrajectoryCaseSpecV1 => {
  const canonicalKinds = (
    kinds: readonly M7PatrolTrajectoryWitnessKindV1[],
  ): M7PatrolTrajectoryWitnessKindV1[] =>
    M7_PATROL_TRAJECTORY_WITNESS_KINDS_V1.filter((kind) =>
      kinds.includes(kind),
    );
  if (
    new Set(input.expectedBaselineWitnessKinds).size !==
      input.expectedBaselineWitnessKinds.length ||
    new Set(input.expectedRecoveryWitnessKinds).size !==
      input.expectedRecoveryWitnessKinds.length
  ) {
    throw new TypeError(
      "trajectory case expectations cannot contain duplicates",
    );
  }
  const basis = caseSpecBasisSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-r3-patrol-trajectory-case-spec",
    classifierId: M7_PATROL_TRAJECTORY_CLASSIFIER_ID_V1,
    classifierImplementationSha256: input.classifierImplementationSha256,
    classifierConfigSha256:
      input.classifierConfigSha256 ??
      M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1.configSha256,
    expectedBaselineWitnessKinds: canonicalKinds(
      input.expectedBaselineWitnessKinds,
    ),
    expectedRecoveryWitnessKinds: canonicalKinds(
      input.expectedRecoveryWitnessKinds,
    ),
    frozenAt: input.frozenAt,
  });
  const caseSpecSha256 = hashJson(basis);
  return deepFreeze(
    M7R3PatrolTrajectoryCaseSpecV1Schema.parse({
      ...basis,
      caseId: `m7-r3-trajectory-case:${caseSpecSha256.slice(0, 24)}`,
      caseSpecSha256,
    }),
  );
};

const sourceIdentitySchema = z
  .object({
    buildId: BuildIdSchema,
    sourceId: SourceIdSchema,
    sourceSha256: Sha256DigestV1Schema,
  })
  .strict();

const trajectoryUseReasonSchema = z.enum([
  "runtime_evidence_receipt_missing",
  "attempt_evidence_receipt_missing",
  "source_change_missing",
  "source_change_does_not_leave_baseline",
  "source_change_inconsistent",
  "baseline_execution_missing",
  "baseline_classifier_mismatch",
  "baseline_expected_witness_missing",
  "baseline_incomplete_or_lossy",
  "baseline_not_agent_visible_before_source_change",
  "baseline_not_available_to_model_before_edit_issued",
  "candidate_identity_missing",
  "candidate_execution_missing",
  "candidate_classifier_mismatch",
  "candidate_expected_recovery_missing",
  "candidate_incomplete_or_lossy",
  "candidate_not_agent_visible_after_source_change",
  "candidate_not_available_to_model_after_edit_issued",
]);
export const M7R3PatrolTrajectoryUseReasonV1Schema = trajectoryUseReasonSchema;
export type M7R3PatrolTrajectoryUseReasonV1 = z.infer<
  typeof M7R3PatrolTrajectoryUseReasonV1Schema
>;

const trajectoryUseEvidenceBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-patrol-trajectory-use-evidence"),
    campaignId: campaignIdSchema,
    caseSpec: M7R3PatrolTrajectoryCaseSpecV1Schema,
    attemptBindingContentSha256: Sha256DigestV1Schema,
    runtimeEvidenceReceiptSha256: Sha256DigestV1Schema.nullable(),
    attemptEvidenceReceiptSha256: Sha256DigestV1Schema.nullable(),
    baselineIdentity: sourceIdentitySchema,
    candidateIdentity: sourceIdentitySchema.nullable(),
    firstHostObservedSourceChange:
      M7R3HostObservedSourceChangeBoundaryV1Schema.nullable(),
    summaries: z.array(M7R3PatrolTrajectoryExecutionSummaryV1Schema).max(1_000),
    baselineSummary: M7R3PatrolTrajectoryExecutionSummaryV1Schema.nullable(),
    candidateSummary: M7R3PatrolTrajectoryExecutionSummaryV1Schema.nullable(),
    baselineWitnesses: z.array(M7PatrolTrajectoryWitnessV1Schema).max(5),
    candidateRecoveryWitnesses: z
      .array(M7PatrolTrajectoryWitnessV1Schema)
      .max(5),
    baselineWitnessAgentVisibleBeforeSourceChange: z.boolean(),
    candidateRecoveryAgentVisibleAfterSourceChange: z.boolean(),
    trajectoryUseEstablished: z.boolean(),
    rejectionReasons: z.array(trajectoryUseReasonSchema).max(16),
    derivedAt: timestampSchema,
  })
  .strict();

type Derivation = Pick<
  z.infer<typeof trajectoryUseEvidenceBasisSchema>,
  | "baselineSummary"
  | "candidateSummary"
  | "baselineWitnesses"
  | "candidateRecoveryWitnesses"
  | "baselineWitnessAgentVisibleBeforeSourceChange"
  | "candidateRecoveryAgentVisibleAfterSourceChange"
  | "trajectoryUseEstablished"
  | "rejectionReasons"
>;

const classifierMatches = (
  summary: M7R3PatrolTrajectoryExecutionSummaryV1,
  spec: M7R3PatrolTrajectoryCaseSpecV1,
): boolean =>
  summary.classifierImplementationSha256 ===
    spec.classifierImplementationSha256 &&
  summary.classification.classifierConfig.configSha256 ===
    spec.classifierConfigSha256;

const usableSummary = (
  summary: M7R3PatrolTrajectoryExecutionSummaryV1,
): boolean =>
  summary.sealed &&
  summary.coverage.complete &&
  !summary.loss.historyLossObserved &&
  !summary.classification.classifierLossObserved &&
  summary.cleanup.proven;

const identityMatches = (
  summary: M7R3PatrolTrajectoryExecutionSummaryV1,
  identity: z.infer<typeof sourceIdentitySchema>,
): boolean =>
  summary.lineage.buildId === identity.buildId &&
  summary.lineage.sourceId === identity.sourceId &&
  summary.lineage.sourceSha256 === identity.sourceSha256;

const selectedWitnesses = (
  summary: M7R3PatrolTrajectoryExecutionSummaryV1 | null,
  kinds: readonly M7PatrolTrajectoryWitnessKindV1[],
): readonly M7PatrolTrajectoryWitnessV1[] =>
  summary === null
    ? []
    : kinds.flatMap((kind) => {
        const witness = summary.classification.witnesses.find(
          (entry) => entry.kind === kind && !entry.fallOffEdge,
        );
        return witness === undefined ? [] : [witness];
      });

const orderedSummaries = (
  summaries: readonly M7R3PatrolTrajectoryExecutionSummaryV1[],
): readonly M7R3PatrolTrajectoryExecutionSummaryV1[] =>
  [...summaries].sort(
    (left, right) =>
      left.agentVisibleAtHostToolReturnOrdinal -
        right.agentVisibleAtHostToolReturnOrdinal ||
      left.lineage.executionId.localeCompare(right.lineage.executionId, "en"),
  );

const chooseSummary = (input: {
  readonly summaries: readonly M7R3PatrolTrajectoryExecutionSummaryV1[];
  readonly identity: z.infer<typeof sourceIdentitySchema>;
  readonly spec: M7R3PatrolTrajectoryCaseSpecV1;
  readonly kinds: readonly M7PatrolTrajectoryWitnessKindV1[];
  readonly boundaryOrdinal: number | null;
  readonly side: "before" | "after";
}): M7R3PatrolTrajectoryExecutionSummaryV1 | null => {
  const identityMatchesOnly = orderedSummaries(input.summaries).filter(
    (summary) => identityMatches(summary, input.identity),
  );
  const scored = identityMatchesOnly.map((summary) => {
    const witnesses = selectedWitnesses(summary, input.kinds);
    const hostOrdered =
      input.boundaryOrdinal !== null &&
      (input.side === "before"
        ? summary.agentVisibleAtHostToolReturnOrdinal < input.boundaryOrdinal
        : summary.agentVisibleAtHostToolReturnOrdinal > input.boundaryOrdinal);
    const boundary = summary.firstHostObservedSourceChange;
    const modelOrdered =
      boundary !== null &&
      (input.side === "before"
        ? summary.agentVisibleFinalToolResult
            .availableToModelAtAgentTurnOrdinal <=
          boundary.sourceChangingToolIssuedInAgentTurnOrdinal
        : summary.agentVisibleFinalToolResult
            .availableToModelAtAgentTurnOrdinal >
          boundary.sourceChangingToolIssuedInAgentTurnOrdinal);
    return {
      summary,
      score:
        (classifierMatches(summary, input.spec) ? 8 : 0) +
        (witnesses.length === input.kinds.length ? 4 : 0) +
        (usableSummary(summary) ? 2 : 0) +
        (hostOrdered && modelOrdered ? 1 : 0),
    };
  });
  scored.sort(
    (left, right) =>
      right.score - left.score ||
      left.summary.agentVisibleAtHostToolReturnOrdinal -
        right.summary.agentVisibleAtHostToolReturnOrdinal,
  );
  return scored[0]?.summary ?? null;
};

const deriveTrajectoryUse = (input: {
  readonly caseSpec: M7R3PatrolTrajectoryCaseSpecV1;
  readonly runtimeEvidenceReceiptSha256: Sha256DigestV1 | null;
  readonly attemptEvidenceReceiptSha256: Sha256DigestV1 | null;
  readonly baselineIdentity: z.infer<typeof sourceIdentitySchema>;
  readonly candidateIdentity: z.infer<typeof sourceIdentitySchema> | null;
  readonly firstHostObservedSourceChange: M7R3HostObservedSourceChangeBoundaryV1 | null;
  readonly summaries: readonly M7R3PatrolTrajectoryExecutionSummaryV1[];
}): Derivation => {
  const boundaryOrdinal =
    input.firstHostObservedSourceChange?.hostToolReturnOrdinal ?? null;
  const baselineSummary = chooseSummary({
    summaries: input.summaries,
    identity: input.baselineIdentity,
    spec: input.caseSpec,
    kinds: input.caseSpec.expectedBaselineWitnessKinds,
    boundaryOrdinal,
    side: "before",
  });
  const candidateSummary =
    input.candidateIdentity === null
      ? null
      : chooseSummary({
          summaries: input.summaries,
          identity: input.candidateIdentity,
          spec: input.caseSpec,
          kinds: input.caseSpec.expectedRecoveryWitnessKinds,
          boundaryOrdinal,
          side: "after",
        });
  const baselineWitnesses = selectedWitnesses(
    baselineSummary,
    input.caseSpec.expectedBaselineWitnessKinds,
  );
  const candidateRecoveryWitnesses = selectedWitnesses(
    candidateSummary,
    input.caseSpec.expectedRecoveryWitnessKinds,
  );
  const reasons = new Set<M7R3PatrolTrajectoryUseReasonV1>();
  if (input.runtimeEvidenceReceiptSha256 === null)
    reasons.add("runtime_evidence_receipt_missing");
  if (input.attemptEvidenceReceiptSha256 === null)
    reasons.add("attempt_evidence_receipt_missing");
  if (input.firstHostObservedSourceChange === null) {
    reasons.add("source_change_missing");
  } else if (
    input.firstHostObservedSourceChange.sourceSha256 ===
    input.baselineIdentity.sourceSha256
  ) {
    reasons.add("source_change_does_not_leave_baseline");
  }
  if (
    input.summaries.some(
      (summary) =>
        !sameJson(
          summary.firstHostObservedSourceChange,
          input.firstHostObservedSourceChange,
        ),
    )
  ) {
    reasons.add("source_change_inconsistent");
  }
  if (baselineSummary === null) {
    reasons.add("baseline_execution_missing");
  } else {
    if (!classifierMatches(baselineSummary, input.caseSpec))
      reasons.add("baseline_classifier_mismatch");
    if (
      baselineWitnesses.length !==
      input.caseSpec.expectedBaselineWitnessKinds.length
    )
      reasons.add("baseline_expected_witness_missing");
    if (!usableSummary(baselineSummary))
      reasons.add("baseline_incomplete_or_lossy");
    if (
      boundaryOrdinal === null ||
      baselineSummary.agentVisibleAtHostToolReturnOrdinal >= boundaryOrdinal
    )
      reasons.add("baseline_not_agent_visible_before_source_change");
    if (
      input.firstHostObservedSourceChange === null ||
      baselineSummary.agentVisibleFinalToolResult
        .availableToModelAtAgentTurnOrdinal >
        input.firstHostObservedSourceChange
          .sourceChangingToolIssuedInAgentTurnOrdinal
    )
      reasons.add("baseline_not_available_to_model_before_edit_issued");
  }
  if (input.candidateIdentity === null) {
    reasons.add("candidate_identity_missing");
  } else if (candidateSummary === null) {
    reasons.add("candidate_execution_missing");
  } else {
    if (!classifierMatches(candidateSummary, input.caseSpec))
      reasons.add("candidate_classifier_mismatch");
    if (
      candidateRecoveryWitnesses.length !==
      input.caseSpec.expectedRecoveryWitnessKinds.length
    )
      reasons.add("candidate_expected_recovery_missing");
    if (!usableSummary(candidateSummary))
      reasons.add("candidate_incomplete_or_lossy");
    if (
      boundaryOrdinal === null ||
      candidateSummary.agentVisibleAtHostToolReturnOrdinal <= boundaryOrdinal
    )
      reasons.add("candidate_not_agent_visible_after_source_change");
    if (
      input.firstHostObservedSourceChange === null ||
      candidateSummary.agentVisibleFinalToolResult
        .availableToModelAtAgentTurnOrdinal <=
        input.firstHostObservedSourceChange
          .sourceChangingToolIssuedInAgentTurnOrdinal
    )
      reasons.add("candidate_not_available_to_model_after_edit_issued");
  }
  const rejectionReasons = trajectoryUseReasonSchema.options.filter((reason) =>
    reasons.has(reason),
  );
  return {
    baselineSummary,
    candidateSummary,
    baselineWitnesses: [...baselineWitnesses],
    candidateRecoveryWitnesses: [...candidateRecoveryWitnesses],
    baselineWitnessAgentVisibleBeforeSourceChange:
      baselineSummary !== null &&
      baselineWitnesses.length ===
        input.caseSpec.expectedBaselineWitnessKinds.length &&
      usableSummary(baselineSummary) &&
      boundaryOrdinal !== null &&
      baselineSummary.agentVisibleAtHostToolReturnOrdinal < boundaryOrdinal &&
      input.firstHostObservedSourceChange !== null &&
      baselineSummary.agentVisibleFinalToolResult
        .availableToModelAtAgentTurnOrdinal <=
        input.firstHostObservedSourceChange
          .sourceChangingToolIssuedInAgentTurnOrdinal,
    candidateRecoveryAgentVisibleAfterSourceChange:
      candidateSummary !== null &&
      candidateRecoveryWitnesses.length ===
        input.caseSpec.expectedRecoveryWitnessKinds.length &&
      usableSummary(candidateSummary) &&
      boundaryOrdinal !== null &&
      candidateSummary.agentVisibleAtHostToolReturnOrdinal > boundaryOrdinal &&
      input.firstHostObservedSourceChange !== null &&
      candidateSummary.agentVisibleFinalToolResult
        .availableToModelAtAgentTurnOrdinal >
        input.firstHostObservedSourceChange
          .sourceChangingToolIssuedInAgentTurnOrdinal,
    trajectoryUseEstablished: rejectionReasons.length === 0,
    rejectionReasons,
  };
};

export const M7R3PatrolTrajectoryUseEvidenceV1Schema =
  trajectoryUseEvidenceBasisSchema
    .extend({ recordContentSha256: Sha256DigestV1Schema })
    .strict()
    .superRefine((value, context) => {
      const expected = deriveTrajectoryUse(value);
      for (const field of [
        "baselineSummary",
        "candidateSummary",
        "baselineWitnesses",
        "candidateRecoveryWitnesses",
        "baselineWitnessAgentVisibleBeforeSourceChange",
        "candidateRecoveryAgentVisibleAfterSourceChange",
        "trajectoryUseEstablished",
        "rejectionReasons",
      ] as const) {
        if (!sameJson(value[field], expected[field])) {
          addIssue(
            context,
            [field],
            "trajectory-use fact does not derive from retained Host evidence",
          );
        }
      }
      const { recordContentSha256, ...basis } = value;
      if (recordContentSha256 !== hashJson(basis)) {
        addIssue(
          context,
          ["recordContentSha256"],
          "trajectory-use evidence hash does not match",
        );
      }
    });
export type M7R3PatrolTrajectoryUseEvidenceV1 = z.infer<
  typeof M7R3PatrolTrajectoryUseEvidenceV1Schema
>;

export const deriveM7R3PatrolTrajectoryUseEvidenceV1 = (input: {
  readonly campaignId: string;
  readonly caseSpec: M7R3PatrolTrajectoryCaseSpecV1;
  readonly attemptBindingContentSha256: Sha256DigestV1;
  readonly runtimeEvidenceReceiptSha256: Sha256DigestV1 | null;
  readonly attemptEvidenceReceiptSha256: Sha256DigestV1 | null;
  readonly baselineIdentity: z.input<typeof sourceIdentitySchema>;
  readonly candidateIdentity: z.input<typeof sourceIdentitySchema> | null;
  readonly firstHostObservedSourceChange: M7R3HostObservedSourceChangeBoundaryV1 | null;
  readonly summaries: readonly M7R3PatrolTrajectoryExecutionSummaryV1[];
  readonly derivedAt: string;
}): M7R3PatrolTrajectoryUseEvidenceV1 => {
  const caseSpec = M7R3PatrolTrajectoryCaseSpecV1Schema.parse(input.caseSpec);
  const baselineIdentity = sourceIdentitySchema.parse(input.baselineIdentity);
  const candidateIdentity =
    input.candidateIdentity === null
      ? null
      : sourceIdentitySchema.parse(input.candidateIdentity);
  if (
    candidateIdentity !== null &&
    candidateIdentity.sourceSha256 === baselineIdentity.sourceSha256
  ) {
    throw new TypeError("R3 candidate source must differ from its baseline");
  }
  const firstHostObservedSourceChange =
    input.firstHostObservedSourceChange === null
      ? null
      : M7R3HostObservedSourceChangeBoundaryV1Schema.parse(
          input.firstHostObservedSourceChange,
        );
  const summaries = input.summaries.map((summary) =>
    M7R3PatrolTrajectoryExecutionSummaryV1Schema.parse(summary),
  );
  const derived = deriveTrajectoryUse({
    caseSpec,
    runtimeEvidenceReceiptSha256: input.runtimeEvidenceReceiptSha256,
    attemptEvidenceReceiptSha256: input.attemptEvidenceReceiptSha256,
    baselineIdentity,
    candidateIdentity,
    firstHostObservedSourceChange,
    summaries,
  });
  const basis = trajectoryUseEvidenceBasisSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-r3-patrol-trajectory-use-evidence",
    campaignId: input.campaignId,
    caseSpec,
    attemptBindingContentSha256: input.attemptBindingContentSha256,
    runtimeEvidenceReceiptSha256: input.runtimeEvidenceReceiptSha256,
    attemptEvidenceReceiptSha256: input.attemptEvidenceReceiptSha256,
    baselineIdentity,
    candidateIdentity,
    firstHostObservedSourceChange,
    summaries,
    ...derived,
    derivedAt: input.derivedAt,
  });
  return deepFreeze(
    M7R3PatrolTrajectoryUseEvidenceV1Schema.parse({
      ...basis,
      recordContentSha256: hashJson(basis),
    }),
  );
};
