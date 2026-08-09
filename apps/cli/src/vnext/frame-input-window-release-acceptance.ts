import { createHash } from "node:crypto";

import { GAME_TOOL_NAMES_V1 } from "@chronorift/agent-protocol";
import {
  JsonValueSchema,
  Sha256DigestV1Schema,
  TaskPatchIdentityV1Schema,
  VNextBuildV1Schema,
  VNextExecutionRecordV1Schema,
  VNextRawRuntimeEventV1Schema,
  asSha256DigestV1,
  type Sha256DigestV1,
  type TaskId,
} from "@chronorift/domain";
import {
  ArtifactNotFoundError,
  VNextRuntimeStore,
  VNextTaskStore,
  canonicalJson,
  contentHash,
} from "@chronorift/json-artifacts";
import { z } from "zod";

import {
  VNextAgentTaskV2Schema,
  VNextAgentTurnV1Schema,
} from "./task-agent-contracts.js";

const fpsSchema = z.union([z.literal(60), z.literal(120)]);
const subjectSchema = z.enum(["baseline", "candidate"]);
const requiredGameToolNames = Object.freeze(Object.values(GAME_TOOL_NAMES_V1));

export const FrameInputWindowScenarioV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    scenarioId: z.string().regex(/^frame-input-window:[a-f0-9]{24}$/u),
    subject: subjectSchema,
    expectedSourceHash: Sha256DigestV1Schema,
    fixedFps: fpsSchema,
    physicsTicksPerSecond: fpsSchema,
    inputTimeUs: z.union([z.literal(75_000), z.literal(250_000)]).nullable(),
    expectedJumping: z.boolean(),
  })
  .strict();
export type FrameInputWindowScenarioV1 = z.infer<
  typeof FrameInputWindowScenarioV1Schema
>;

export const FrameInputWindowObservationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    scenarioId: z.string().regex(/^frame-input-window:[a-f0-9]{24}$/u),
    sourceHash: Sha256DigestV1Schema,
    realizedFixedFps: fpsSchema,
    realizedPhysicsTicksPerSecond: fpsSchema,
    requestedInputTimeUs: z
      .union([z.literal(75_000), z.literal(250_000)])
      .nullable(),
    realizedInputTimeUs: z.number().int().nonnegative().nullable(),
    jumping: z.boolean(),
    processFrames: z.number().int().positive(),
    physicsTicks: z.number().int().nonnegative(),
    runtimeStatus: z.literal("completed"),
    protocolErrors: z.array(z.string().min(1).max(1_024)),
    droppedEventCount: z.number().int().nonnegative(),
    observationComplete: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.requestedInputTimeUs === null) !==
      (value.realizedInputTimeUs === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["realizedInputTimeUs"],
        message:
          "realized input time must be present exactly when input was requested",
      });
    }
  });
export type FrameInputWindowObservationV1 = z.infer<
  typeof FrameInputWindowObservationV1Schema
>;

export interface FrameInputWindowScenarioRunnerV1 {
  run(
    scenario: FrameInputWindowScenarioV1,
    signal?: AbortSignal,
  ): Promise<FrameInputWindowObservationV1>;
}

const requestedScenarioControlsSchema = z
  .object({
    fixedFps: fpsSchema,
    physicsTicksPerSecond: fpsSchema,
    maxTicks: z.literal(64),
    inputTimeUs: z.union([z.literal(75_000), z.literal(250_000)]).nullable(),
  })
  .strict();

const candidateExecutionFailureEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    scenarioId: z.string().regex(/^frame-input-window:[a-f0-9]{24}$/u),
    stage: z.enum(["launch", "step"]),
    toolName: z.enum(["game_launch", "game_step"]),
    error: z
      .object({
        code: z.enum([
          "runtime_crashed",
          "runtime_unavailable",
          "operation_failed",
        ]),
        message: z.string().min(1).max(4_096),
      })
      .strict(),
    expectedSourceHash: Sha256DigestV1Schema,
    requestedControls: requestedScenarioControlsSchema,
    cleanupProven: z.literal(true),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedTool = value.stage === "launch" ? "game_launch" : "game_step";
    if (value.toolName !== expectedTool) {
      context.addIssue({
        code: "custom",
        path: ["toolName"],
        message: "candidate failure tool must match its execution stage",
      });
    }
  });
export type FrameInputWindowCandidateExecutionFailureEvidenceV1 = z.infer<
  typeof candidateExecutionFailureEvidenceSchema
>;

/**
 * A validated candidate-runtime failure whose Task descendants have already
 * been cleaned up. It contains requested identities and controls only; it must
 * never synthesize an observation or claim that controls were realized.
 */
export class FrameInputWindowCandidateExecutionError extends Error {
  public readonly evidence: FrameInputWindowCandidateExecutionFailureEvidenceV1;

  public constructor(
    evidenceInput: FrameInputWindowCandidateExecutionFailureEvidenceV1,
  ) {
    const evidence =
      candidateExecutionFailureEvidenceSchema.parse(evidenceInput);
    super(
      `${evidence.toolName} failed (${evidence.error.code}): ${evidence.error.message}`,
    );
    this.name = "FrameInputWindowCandidateExecutionError";
    this.evidence = evidence;
  }
}

const observedScenarioSchema = z
  .object({
    schemaVersion: z.literal(1),
    outcome: z.literal("observed"),
    scenario: FrameInputWindowScenarioV1Schema,
    observation: FrameInputWindowObservationV1Schema,
    matched: z.boolean(),
    failures: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.matched !== (value.failures.length === 0)) {
      context.addIssue({
        code: "custom",
        path: ["matched"],
        message: "matched must be derived from the absence of failures",
      });
    }
  });

const candidateExecutionFailedScenarioSchema = z
  .object({
    schemaVersion: z.literal(1),
    outcome: z.literal("candidate_execution_failed"),
    scenario: FrameInputWindowScenarioV1Schema,
    failure: candidateExecutionFailureEvidenceSchema,
    matched: z.literal(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scenario.subject !== "candidate") {
      context.addIssue({
        code: "custom",
        path: ["scenario", "subject"],
        message:
          "only a candidate scenario can have a candidate execution failure",
      });
    }
    if (value.failure.scenarioId !== value.scenario.scenarioId) {
      context.addIssue({
        code: "custom",
        path: ["failure", "scenarioId"],
        message: "candidate failure must identify the evaluated scenario",
      });
    }
    if (
      value.failure.expectedSourceHash !== value.scenario.expectedSourceHash
    ) {
      context.addIssue({
        code: "custom",
        path: ["failure", "expectedSourceHash"],
        message:
          "candidate failure must identify the requested candidate source",
      });
    }
    const requested = value.failure.requestedControls;
    if (
      requested.fixedFps !== value.scenario.fixedFps ||
      requested.physicsTicksPerSecond !==
        value.scenario.physicsTicksPerSecond ||
      requested.inputTimeUs !== value.scenario.inputTimeUs
    ) {
      context.addIssue({
        code: "custom",
        path: ["failure", "requestedControls"],
        message: "candidate failure controls must match the scenario request",
      });
    }
  });

const evaluatedScenarioSchema = z.discriminatedUnion("outcome", [
  observedScenarioSchema,
  candidateExecutionFailedScenarioSchema,
]);

export const M3LiveTaskEvidenceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.literal("openai-codex"),
    model: z.literal("gpt-5.6-luna"),
    thinkingLevel: z.literal("max"),
    loopStatus: z.enum([
      "completed",
      "provider_failed",
      "aborted",
      "timed_out",
    ]),
    finalCandidateSourceHash: Sha256DigestV1Schema,
    sealedExecutionSourceHashes: z.array(Sha256DigestV1Schema).max(1_000),
    gameToolCallCount: z.number().int().nonnegative(),
  })
  .strict();
export type M3LiveTaskEvidenceV1 = z.infer<typeof M3LiveTaskEvidenceV1Schema>;

const persistedGameToolCallSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().min(1),
    toolCallId: z.string().min(1).max(256),
    toolName: z.enum(GAME_TOOL_NAMES_V1),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    input: JsonValueSchema,
    response: JsonValueSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.endedAt) < Date.parse(value.startedAt)) {
      context.addIssue({
        code: "custom",
        path: ["endedAt"],
        message: "game tool call cannot end before it starts",
      });
    }
    if (
      value.response === null ||
      typeof value.response !== "object" ||
      Array.isArray(value.response) ||
      value.response["toolCallId"] !== value.toolCallId
    ) {
      context.addIssue({
        code: "custom",
        path: ["response"],
        message: "game tool response must match the persisted toolCallId",
      });
    }
  });

const persistedExecutionSealSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().min(1),
    executionId: z.string().min(1),
    count: z.number().int().nonnegative(),
    headHash: Sha256DigestV1Schema.nullable(),
    byteLength: z.number().int().nonnegative(),
    contentHash: Sha256DigestV1Schema,
  })
  .strict();

/**
 * Derives release evidence from the immutable Task/runtime stores. Callers do
 * not get to supply a trusted summary of model identity, game calls, or sealed
 * execution lineage.
 */
export const collectM3LiveTaskEvidenceV1 = async (input: {
  readonly taskId: TaskId;
  readonly runtimeRoot: string;
}): Promise<{
  readonly candidateSourceHash: Sha256DigestV1;
  readonly patchHash: Sha256DigestV1;
  readonly patchByteLength: number;
  readonly evidence: M3LiveTaskEvidenceV1;
}> => {
  const taskStore = new VNextTaskStore(input.runtimeRoot);
  const runtimeStore = new VNextRuntimeStore(input.runtimeRoot);
  const [task, turns, patch, runtimeSummary] = await Promise.all([
    taskStore.readJson(input.taskId, "agent-task.json", (value) =>
      VNextAgentTaskV2Schema.parse(value),
    ),
    taskStore.readLedger(input.taskId, "agent-turns.jsonl", (value) =>
      VNextAgentTurnV1Schema.parse(value),
    ),
    taskStore.readJson(input.taskId, "patch.json", (value) =>
      TaskPatchIdentityV1Schema.parse(value),
    ),
    runtimeStore.summarize(input.taskId),
  ]);
  if (patch.taskId !== input.taskId || task.taskId !== input.taskId) {
    throw new Error("release evidence is detached from the requested Task");
  }
  if (turns.length !== 1 || turns[0]?.kind !== "start") {
    throw new Error("release evidence requires exactly one Agent start turn");
  }
  const turn = turns[0];
  if (
    turn.taskId !== input.taskId ||
    turn.turn !== 1 ||
    turn.provider !== task.provider ||
    turn.model !== task.model ||
    turn.requestedThinkingLevel !== task.thinkingLevel
  ) {
    throw new Error("release Agent turn history is detached from its Task");
  }
  if (
    task.provider !== "openai-codex" ||
    task.model !== "gpt-5.6-luna" ||
    task.thinkingLevel !== "max" ||
    turn.realizedThinkingLevel !== "max"
  ) {
    throw new Error(
      "release evidence requires realized openai-codex/gpt-5.6-luna/max",
    );
  }
  const activeGameTools = new Set(
    turn.activeTools.filter((toolName) =>
      (requiredGameToolNames as readonly string[]).includes(toolName),
    ),
  );
  if (
    activeGameTools.size !== requiredGameToolNames.length ||
    requiredGameToolNames.some((toolName) => !activeGameTools.has(toolName))
  ) {
    throw new Error(
      "release Agent turn did not expose the complete game tool set",
    );
  }

  const toolCallIds =
    runtimeSummary.kinds.find((entry) => entry.resourceKind === "tool-call")
      ?.resourceIds ?? [];
  for (const toolCallId of toolCallIds) {
    const toolCall = await runtimeStore.readResource(
      input.taskId,
      "tool-call",
      toolCallId,
      (value) => persistedGameToolCallSchema.parse(value),
    );
    if (
      toolCall.taskId !== input.taskId ||
      toolCall.toolCallId !== toolCallId
    ) {
      throw new Error("persisted game tool call has detached lineage");
    }
  }

  const sealedExecutionSourceHashes: Sha256DigestV1[] = [];
  for (const execution of runtimeSummary.executions) {
    let record: z.infer<typeof VNextExecutionRecordV1Schema>;
    try {
      record = await runtimeStore.readResource(
        input.taskId,
        "execution",
        execution.executionId,
        (value) => VNextExecutionRecordV1Schema.parse(value),
      );
    } catch (error) {
      if (!execution.sealed && error instanceof ArtifactNotFoundError) {
        continue;
      }
      throw error;
    }
    if (
      record.taskId !== input.taskId ||
      record.executionId !== execution.executionId
    ) {
      throw new Error("execution record has detached lineage");
    }
    if (!record.sealed) {
      if (execution.sealed) {
        throw new Error(
          "unsealed execution record has an unexpected physical seal",
        );
      }
      continue;
    }
    const [events, physicalSealInput] = await Promise.all([
      runtimeStore.readExecutionEvents(
        input.taskId,
        execution.executionId,
        (value) => VNextRawRuntimeEventV1Schema.parse(value),
      ),
      runtimeStore.readExecutionSeal(input.taskId, execution.executionId),
    ]);
    const physicalSeal = persistedExecutionSealSchema.parse(physicalSealInput);
    const recordedSeal = persistedExecutionSealSchema.parse(
      record.manifest.launchParameters["executionSeal"],
    );
    if (
      physicalSeal.taskId !== input.taskId ||
      physicalSeal.executionId !== execution.executionId ||
      physicalSeal.count !== events.length ||
      canonicalJson(JsonValueSchema.parse(physicalSeal)) !==
        canonicalJson(JsonValueSchema.parse(recordedSeal))
    ) {
      throw new Error(
        "sealed execution record does not match its physical ledger seal",
      );
    }
    if (
      contentHash(JsonValueSchema.parse(events)) !==
      contentHash(JsonValueSchema.parse(record.events))
    ) {
      throw new Error(
        "sealed execution resource does not match its raw ledger",
      );
    }
    const { recordHash, ...recordBasis } = record;
    if (recordHash !== contentHash(JsonValueSchema.parse(recordBasis))) {
      throw new Error("sealed execution recordHash does not match its content");
    }
    const build = await runtimeStore.readResource(
      input.taskId,
      "build",
      record.buildId,
      (value) => VNextBuildV1Schema.parse(value),
    );
    if (
      build.taskId !== input.taskId ||
      build.buildId !== record.buildId ||
      build.sourceId !== record.manifest.sourceId
    ) {
      throw new Error("sealed execution build lineage is inconsistent");
    }
    sealedExecutionSourceHashes.push(build.sourceHash);
  }

  return {
    candidateSourceHash: patch.candidateSourceHash,
    patchHash: patch.patchHash,
    patchByteLength: patch.byteLength,
    evidence: M3LiveTaskEvidenceV1Schema.parse({
      schemaVersion: 1,
      provider: task.provider,
      model: task.model,
      thinkingLevel: turn.realizedThinkingLevel,
      loopStatus: turn.status,
      finalCandidateSourceHash: patch.candidateSourceHash,
      sealedExecutionSourceHashes,
      gameToolCallCount: toolCallIds.length,
    }),
  };
};

const evaluatedAcceptanceSchema = z
  .object({
    schemaVersion: z.literal(1),
    evaluator: z.literal("frame-input-window-release-acceptance-v1"),
    releaseCandidateId: z
      .string()
      .regex(/^m3-release-candidate:[a-f0-9]{64}$/u),
    candidateSourceHash: Sha256DigestV1Schema,
    outcome: z.literal("evaluated"),
    accepted: z.boolean(),
    taskEvidence: M3LiveTaskEvidenceV1Schema,
    taskEvidenceFailures: z.array(z.string().min(1)),
    scenarios: z.array(evaluatedScenarioSchema).min(1).max(13),
  })
  .strict()
  .superRefine((value, context) => {
    const derivedAcceptance =
      value.taskEvidenceFailures.length === 0 &&
      value.scenarios.length === 13 &&
      value.scenarios.every(
        (entry) =>
          entry.outcome === "observed" &&
          entry.matched &&
          entry.failures.length === 0,
      );
    if (value.accepted !== derivedAcceptance) {
      context.addIssue({
        code: "custom",
        path: ["accepted"],
        message:
          "accepted must be derived from task evidence and every scenario result",
      });
    }
  });

export const FrameInputWindowReleaseAcceptanceV1Schema = z.discriminatedUnion(
  "outcome",
  [
    evaluatedAcceptanceSchema,
    z
      .object({
        schemaVersion: z.literal(1),
        evaluator: z.literal("frame-input-window-release-acceptance-v1"),
        releaseCandidateId: z
          .string()
          .regex(/^m3-release-candidate:[a-f0-9]{64}$/u),
        candidateSourceHash: Sha256DigestV1Schema,
        outcome: z.literal("infrastructure_failure"),
        message: z.string().min(1).max(4_096),
        completedScenarioIds: z.array(
          z.string().regex(/^frame-input-window:[a-f0-9]{24}$/u),
        ),
      })
      .strict(),
  ],
);
export type FrameInputWindowReleaseAcceptanceV1 = z.infer<
  typeof FrameInputWindowReleaseAcceptanceV1Schema
>;

export type M3LiveAcceptanceNextActionV1 =
  | {
      readonly kind: "agent_attempt";
      readonly candidateSourceHash: Sha256DigestV1;
    }
  | {
      readonly kind: "evaluator_retry";
      readonly releaseCandidateId: string;
      readonly candidateSourceHash: Sha256DigestV1;
    }
  | {
      readonly kind: "complete";
      readonly releaseCandidateId: string;
      readonly candidateSourceHash: Sha256DigestV1;
    };

/**
 * Enforces one live Agent attempt per immutable candidate. Infrastructure may
 * retry the evaluator against the same bytes; an evaluated rejection requires
 * a different candidate source identity before another Agent attempt.
 */
export const planM3LiveAcceptanceAttemptV1 = (input: {
  readonly candidateSourceHash: Sha256DigestV1;
  readonly history: readonly FrameInputWindowReleaseAcceptanceV1[];
}): M3LiveAcceptanceNextActionV1 => {
  const candidateSourceHash = Sha256DigestV1Schema.parse(
    input.candidateSourceHash,
  );
  const history = input.history.map((entry) =>
    FrameInputWindowReleaseAcceptanceV1Schema.parse(entry),
  );
  const sameCandidate = history.filter(
    (entry) => entry.candidateSourceHash === candidateSourceHash,
  );
  const evaluated = sameCandidate.find(
    (entry) => entry.outcome === "evaluated",
  );
  if (evaluated?.outcome === "evaluated") {
    if (!evaluated.accepted) {
      throw new Error(
        "an evaluated rejection requires a substantively different candidate source identity",
      );
    }
    return {
      kind: "complete",
      releaseCandidateId: evaluated.releaseCandidateId,
      candidateSourceHash,
    };
  }
  const infrastructureFailure = sameCandidate.at(-1);
  if (infrastructureFailure?.outcome === "infrastructure_failure") {
    return {
      kind: "evaluator_retry",
      releaseCandidateId: infrastructureFailure.releaseCandidateId,
      candidateSourceHash,
    };
  }
  return { kind: "agent_attempt", candidateSourceHash };
};

const digest = (value: string): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));

const scenarioId = (input: {
  readonly subject: "baseline" | "candidate";
  readonly fixedFps: 60 | 120;
  readonly physicsTicksPerSecond: 60 | 120;
  readonly inputTimeUs: 75_000 | 250_000 | null;
}): string =>
  `frame-input-window:${digest(
    `${input.subject}\0${input.fixedFps}\0${input.physicsTicksPerSecond}\0${String(input.inputTimeUs)}`,
  ).slice(0, 24)}`;

export const createFrameInputWindowAcceptanceMatrixV1 = (input: {
  readonly baselineSourceHash: Sha256DigestV1;
  readonly candidateSourceHash: Sha256DigestV1;
}): readonly FrameInputWindowScenarioV1[] => {
  const scenarios: FrameInputWindowScenarioV1[] = [];
  const add = (
    subject: "baseline" | "candidate",
    expectedSourceHash: Sha256DigestV1,
    fixedFps: 60 | 120,
    physicsTicksPerSecond: 60 | 120,
    inputTimeUs: 75_000 | 250_000 | null,
    expectedJumping: boolean,
  ): void => {
    scenarios.push(
      FrameInputWindowScenarioV1Schema.parse({
        schemaVersion: 1,
        scenarioId: scenarioId({
          subject,
          fixedFps,
          physicsTicksPerSecond,
          inputTimeUs,
        }),
        subject,
        expectedSourceHash,
        fixedFps,
        physicsTicksPerSecond,
        inputTimeUs,
        expectedJumping,
      }),
    );
  };

  // The frozen buggy source must still reproduce the original 120/60/75ms
  // failure. This prevents an evaluator or fixture drift from producing a
  // false release signal.
  add("baseline", input.baselineSourceHash, 120, 60, 75_000, false);
  for (const fixedFps of [60, 120] as const) {
    for (const physicsTicksPerSecond of [60, 120] as const) {
      add(
        "candidate",
        input.candidateSourceHash,
        fixedFps,
        physicsTicksPerSecond,
        75_000,
        true,
      );
      add(
        "candidate",
        input.candidateSourceHash,
        fixedFps,
        physicsTicksPerSecond,
        250_000,
        false,
      );
      add(
        "candidate",
        input.candidateSourceHash,
        fixedFps,
        physicsTicksPerSecond,
        null,
        false,
      );
    }
  }
  return Object.freeze(scenarios);
};

const evaluateObservation = (
  scenario: FrameInputWindowScenarioV1,
  observation: FrameInputWindowObservationV1,
): readonly string[] => {
  const failures: string[] = [];
  if (observation.scenarioId !== scenario.scenarioId) {
    failures.push("scenario identity did not match the request");
  }
  if (observation.sourceHash !== scenario.expectedSourceHash) {
    failures.push(
      "execution source identity did not match the requested subject",
    );
  }
  if (observation.realizedFixedFps !== scenario.fixedFps) {
    failures.push("fixed FPS was not realized exactly");
  }
  if (
    observation.realizedPhysicsTicksPerSecond !== scenario.physicsTicksPerSecond
  ) {
    failures.push("physics TPS was not realized exactly");
  }
  if (observation.requestedInputTimeUs !== scenario.inputTimeUs) {
    failures.push("runtime receipt changed the requested input time");
  }
  if (
    scenario.inputTimeUs !== null &&
    observation.realizedInputTimeUs !== null
  ) {
    const frameDurationUs = Math.ceil(1_000_000 / scenario.fixedFps);
    if (
      observation.realizedInputTimeUs < scenario.inputTimeUs ||
      observation.realizedInputTimeUs >= scenario.inputTimeUs + frameDurationUs
    ) {
      failures.push(
        "input realization exceeded one process-frame quantization",
      );
    }
  }
  if (observation.jumping !== scenario.expectedJumping) {
    failures.push(
      `player.jumping was ${String(observation.jumping)}; expected ${String(scenario.expectedJumping)}`,
    );
  }
  if (observation.protocolErrors.length > 0) {
    failures.push("Godot runtime/protocol reported an error");
  }
  if (observation.droppedEventCount > 0) {
    failures.push("runtime observation lost events");
  }
  if (!observation.observationComplete) {
    failures.push("runtime observation coverage was incomplete");
  }
  return failures;
};

/**
 * Release-only external evaluator. Its result is intentionally not a Task,
 * Execution, patch, or Harness verdict and must not be written into those
 * product records.
 */
export const runFrameInputWindowReleaseAcceptanceV1 = async (input: {
  readonly baselineSourceHash: Sha256DigestV1;
  readonly candidateSourceHash: Sha256DigestV1;
  readonly taskEvidence: M3LiveTaskEvidenceV1;
  readonly runner: FrameInputWindowScenarioRunnerV1;
  readonly signal?: AbortSignal | undefined;
}): Promise<FrameInputWindowReleaseAcceptanceV1> => {
  const releaseCandidateId = `m3-release-candidate:${digest(
    `frame-input-window\0${input.baselineSourceHash}\0${input.candidateSourceHash}`,
  )}`;
  const taskEvidence = M3LiveTaskEvidenceV1Schema.parse(input.taskEvidence);
  if (taskEvidence.loopStatus !== "completed") {
    return FrameInputWindowReleaseAcceptanceV1Schema.parse({
      schemaVersion: 1,
      evaluator: "frame-input-window-release-acceptance-v1",
      releaseCandidateId,
      candidateSourceHash: input.candidateSourceHash,
      outcome: "infrastructure_failure",
      message: `live Agent turn ended with ${taskEvidence.loopStatus}`,
      completedScenarioIds: [],
    });
  }
  const taskEvidenceFailures: string[] = [];
  if (taskEvidence.finalCandidateSourceHash !== input.candidateSourceHash) {
    taskEvidenceFailures.push(
      "Task handoff source identity did not match the release candidate",
    );
  }
  if (taskEvidence.gameToolCallCount < 1) {
    taskEvidenceFailures.push("live Agent did not call a game tool");
  }
  if (
    !taskEvidence.sealedExecutionSourceHashes.includes(
      input.candidateSourceHash,
    )
  ) {
    taskEvidenceFailures.push(
      "no sealed Agent execution used the final candidate source identity",
    );
  }
  const scenarios = createFrameInputWindowAcceptanceMatrixV1(input);
  const evaluated: z.infer<typeof evaluatedScenarioSchema>[] = [];
  for (const scenario of scenarios) {
    try {
      if (input.signal?.aborted === true) {
        throw input.signal.reason ?? new Error("acceptance aborted");
      }
      const observation = FrameInputWindowObservationV1Schema.parse(
        await input.runner.run(scenario, input.signal),
      );
      const failures = [...evaluateObservation(scenario, observation)];
      if (scenario.subject === "baseline" && failures.length > 0) {
        return FrameInputWindowReleaseAcceptanceV1Schema.parse({
          schemaVersion: 1,
          evaluator: "frame-input-window-release-acceptance-v1",
          releaseCandidateId,
          candidateSourceHash: input.candidateSourceHash,
          outcome: "infrastructure_failure",
          message: `frozen baseline reproduction mismatched evaluator expectations: ${failures.join("; ")}`,
          completedScenarioIds: [scenario.scenarioId],
        });
      }
      evaluated.push({
        schemaVersion: 1,
        outcome: "observed",
        scenario,
        observation,
        matched: failures.length === 0,
        failures,
      });
    } catch (error) {
      if (error instanceof FrameInputWindowCandidateExecutionError) {
        const candidateFailure =
          candidateExecutionFailedScenarioSchema.safeParse({
            schemaVersion: 1,
            outcome: "candidate_execution_failed",
            scenario,
            failure: error.evidence,
            matched: false,
          });
        if (candidateFailure.success) {
          evaluated.push(candidateFailure.data);
          return FrameInputWindowReleaseAcceptanceV1Schema.parse({
            schemaVersion: 1,
            evaluator: "frame-input-window-release-acceptance-v1",
            releaseCandidateId,
            candidateSourceHash: input.candidateSourceHash,
            outcome: "evaluated",
            accepted: false,
            taskEvidence,
            taskEvidenceFailures,
            scenarios: evaluated,
          });
        }
        error = new Error(
          "candidate execution failure evidence did not match the requested scenario",
          { cause: candidateFailure.error },
        );
      }
      return FrameInputWindowReleaseAcceptanceV1Schema.parse({
        schemaVersion: 1,
        evaluator: "frame-input-window-release-acceptance-v1",
        releaseCandidateId,
        candidateSourceHash: input.candidateSourceHash,
        outcome: "infrastructure_failure",
        message: error instanceof Error ? error.message : String(error),
        completedScenarioIds: evaluated.map(
          (entry) => entry.scenario.scenarioId,
        ),
      });
    }
  }
  return FrameInputWindowReleaseAcceptanceV1Schema.parse({
    schemaVersion: 1,
    evaluator: "frame-input-window-release-acceptance-v1",
    releaseCandidateId,
    candidateSourceHash: input.candidateSourceHash,
    outcome: "evaluated",
    accepted:
      taskEvidenceFailures.length === 0 &&
      evaluated.every((entry) => entry.matched),
    taskEvidence,
    taskEvidenceFailures,
    scenarios: evaluated,
  });
};

export const runM3BoundedEvaluatorOnlyAcceptanceV1 = async (input: {
  readonly baselineSourceHash: Sha256DigestV1;
  readonly candidateSourceHash: Sha256DigestV1;
  readonly taskEvidence: M3LiveTaskEvidenceV1;
  readonly maximumAttempts: 1 | 2;
  readonly createRunner: (attempt: number) => FrameInputWindowScenarioRunnerV1;
  readonly beforeRetry?:
    | ((input: {
        readonly completedAttempts: number;
        readonly history: readonly FrameInputWindowReleaseAcceptanceV1[];
      }) => Promise<void>)
    | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<{
  readonly acceptance: FrameInputWindowReleaseAcceptanceV1;
  readonly attempts: number;
  readonly history: readonly FrameInputWindowReleaseAcceptanceV1[];
}> => {
  const history: FrameInputWindowReleaseAcceptanceV1[] = [];
  for (let attempt = 1; attempt <= input.maximumAttempts; attempt += 1) {
    if (attempt > 1) {
      const next = planM3LiveAcceptanceAttemptV1({
        candidateSourceHash: input.candidateSourceHash,
        history,
      });
      if (next.kind !== "evaluator_retry") {
        throw new Error(
          "bounded evaluator retry attempted to change the Agent/candidate state",
        );
      }
      await input.beforeRetry?.({
        completedAttempts: attempt - 1,
        history: Object.freeze([...history]),
      });
    }
    const acceptance = await runFrameInputWindowReleaseAcceptanceV1({
      baselineSourceHash: input.baselineSourceHash,
      candidateSourceHash: input.candidateSourceHash,
      taskEvidence: input.taskEvidence,
      runner: input.createRunner(attempt),
      signal: input.signal,
    });
    history.push(acceptance);
    if (
      acceptance.outcome !== "infrastructure_failure" ||
      attempt === input.maximumAttempts
    ) {
      return Object.freeze({
        acceptance,
        attempts: attempt,
        history: Object.freeze([...history]),
      });
    }
  }
  throw new Error("bounded evaluator retry exhausted without an outcome");
};

export const M3LiveAcceptanceSummaryV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    evaluator: z.literal("frame-input-window-release-acceptance-v1"),
    releaseCandidateId: z
      .string()
      .regex(/^m3-release-candidate:[a-f0-9]{64}$/u),
    candidateSourceHash: Sha256DigestV1Schema,
    provider: z.literal("openai-codex"),
    model: z.literal("gpt-5.6-luna"),
    thinkingLevel: z.literal("max"),
    agentTurns: z.literal(1),
    evaluatorAttempts: z.number().int().min(1).max(2),
    observedScenarios: z.literal(13),
    accepted: z.literal(true),
    cleanupProven: z.literal(true),
  })
  .strict();
export type M3LiveAcceptanceSummaryV1 = z.infer<
  typeof M3LiveAcceptanceSummaryV1Schema
>;

export const createM3LiveAcceptanceSummaryV1 = (input: {
  readonly acceptance: FrameInputWindowReleaseAcceptanceV1;
  readonly evaluatorAttempts: number;
  readonly cleanupProven: boolean;
}): M3LiveAcceptanceSummaryV1 => {
  const acceptance = FrameInputWindowReleaseAcceptanceV1Schema.parse(
    input.acceptance,
  );
  if (acceptance.outcome !== "evaluated" || !acceptance.accepted) {
    throw new Error("a live success summary requires accepted evaluation");
  }
  return M3LiveAcceptanceSummaryV1Schema.parse({
    schemaVersion: 1,
    evaluator: acceptance.evaluator,
    releaseCandidateId: acceptance.releaseCandidateId,
    candidateSourceHash: acceptance.candidateSourceHash,
    provider: acceptance.taskEvidence.provider,
    model: acceptance.taskEvidence.model,
    thinkingLevel: acceptance.taskEvidence.thinkingLevel,
    agentTurns: 1,
    evaluatorAttempts: input.evaluatorAttempts,
    observedScenarios: acceptance.scenarios.length,
    accepted: acceptance.accepted,
    cleanupProven: input.cleanupProven,
  });
};
