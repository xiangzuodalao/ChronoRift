import {
  GAME_TOOL_NAMES_V1,
  validateGameTaskIdV1,
  validateGameToolInputV1,
  validateGameToolOutputV1,
  type GameCapabilitiesOutputV1,
  type GameInputOutputV1,
  type GameLaunchOutputV1,
  type GameQueryOutputV1,
  type GameStepOutputV1,
  type GameStopOutputV1,
} from "@chronorift/agent-protocol";
import {
  JsonValueSchema,
  RuntimeStepReceiptV1Schema,
  StateSnapshotSchema,
  VNextBuildV1Schema,
  VNextCaptureCoverageV1Schema,
  VNextCaptureLossV1Schema,
  VNextClockPositionV1Schema,
  VNextRuntimeV1Schema,
  type JsonValue,
  type TaskId,
} from "@chronorift/domain";
import {
  VNextGameToolResponseV1Schema,
  type VNextGameToolPort,
  type VNextGameToolErrorCodeV1,
  type VNextGameToolPortRequestV1,
} from "@chronorift/pi-harness";
import { Check } from "typebox/value";
import { z } from "zod";

import {
  FrameInputWindowCandidateExecutionError,
  FrameInputWindowObservationV1Schema,
  FrameInputWindowScenarioV1Schema,
  type FrameInputWindowCandidateExecutionFailureEvidenceV1,
  type FrameInputWindowObservationV1,
  type FrameInputWindowScenarioRunnerV1,
  type FrameInputWindowScenarioV1,
} from "./frame-input-window-release-acceptance.js";

const MAX_SCENARIO_TICKS = 64;
const POST_OBSERVATION_FRAMES = 2;
const NO_INPUT_OBSERVATION_TIME_US = 250_000;
const QUERY_PAGE_LIMIT = 200;
const MAX_QUERY_PAGES = 16;

const launchBuildSchema = z
  .object({
    buildId: z.string().min(1),
    sourceId: z.string().min(1),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

const realizedControlsSchema = z
  .object({
    fixedFps: z.union([z.literal(60), z.literal(120)]),
    physicsTicksPerSecond: z.union([z.literal(60), z.literal(120)]),
    maxTicks: z.number().int().min(1).max(600),
    stepsUsed: z.number().int().nonnegative().max(600),
  })
  .strict();

const requestedPointSchema = z
  .object({
    clock: z.literal("process_frame"),
    requestedTick: z.number().int().nonnegative().max(600),
    requestedPhase: z.literal("process_frame_start"),
  })
  .strict();

const candidateFailureProofSchema = z
  .object({
    schemaVersion: z.literal(1),
    attribution: z.literal("candidate_source"),
    stage: z.enum(["launch", "step"]),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

const inputRealizationReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z.string().min(1).max(256),
    requested: requestedPointSchema,
    realized: VNextClockPositionV1Schema.extend({
      phase: z.literal("process_frame_start"),
      quantized: z.boolean(),
      mismatchReason: z.string().min(1).nullable(),
    }).strict(),
    knownSideEffects: z.array(z.string().min(1).max(4_096)).max(32),
  })
  .strict();

const stepReceiptSchema = z
  .object({
    requestedTick: z.number().int().nonnegative(),
    realizedTick: z.number().int().nonnegative(),
    requestedDeltaUs: z.number().int().positive(),
    realizedDeltaUs: z.number().int().positive(),
    appliedInputOrders: z.array(z.number().int().nonnegative()).max(128),
    runtime: RuntimeStepReceiptV1Schema,
  })
  .strict();

const stepProjectionSchema = z
  .object({
    runtimeId: z.string().min(1),
    executionId: z.string().min(1),
    requested: z
      .object({
        clock: z.literal("process_frame"),
        count: z.number().int().min(1).max(600),
      })
      .strict(),
    realized: z
      .object({
        processFrames: z.number().int().positive(),
        physicsTicks: z.number().int().nonnegative(),
        requestedClockProgress: z.number().int().nonnegative(),
        overshoot: z.number().int().nonnegative(),
      })
      .strict(),
    state: StateSnapshotSchema,
    clocks: VNextClockPositionV1Schema,
    receipts: z.array(inputRealizationReceiptSchema).max(600),
    stepReceipts: z.array(stepReceiptSchema).min(1).max(600),
    pendingInputs: z
      .array(
        z
          .object({
            requestId: z.string().min(1).max(256),
            requested: requestedPointSchema,
          })
          .strict(),
      )
      .max(600),
    coverage: z.array(VNextCaptureCoverageV1Schema).max(32),
    loss: z.array(VNextCaptureLossV1Schema).max(2_000),
  })
  .strict();

export interface FrameInputWindowEvaluatorTaskV1 {
  /** A new immutable Task namespace for exactly one external scenario. */
  readonly taskId: TaskId;
  readonly port: VNextGameToolPort;
  /** Stops the Task broker and proves descendant cleanup. */
  close(): Promise<void>;
}

export interface FrameInputWindowEvaluatorTaskFactoryV1 {
  create(
    scenario: FrameInputWindowScenarioV1,
    signal?: AbortSignal,
  ): Promise<FrameInputWindowEvaluatorTaskV1>;
}

export interface FrameInputWindowEvaluatorCleanupReceiptV1 {
  readonly processGroupTerminated: boolean;
  readonly cgroupPopulated: boolean;
  readonly scopeRemoved: boolean;
}

const EVALUATOR_CLEANUP_ATTEMPTS = 2;

const proveFrameInputWindowEvaluatorCleanupV1 = async (input: {
  readonly cleanup: () => Promise<FrameInputWindowEvaluatorCleanupReceiptV1>;
}): Promise<void> => {
  let lastFailure: unknown = new Error(
    "external evaluator Task cleanup was not attempted",
  );
  for (let attempt = 0; attempt < EVALUATOR_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      const receipt = await input.cleanup();
      if (
        receipt.processGroupTerminated &&
        !receipt.cgroupPopulated &&
        receipt.scopeRemoved
      ) {
        return;
      }
      lastFailure = new Error(
        "external evaluator Task cleanup receipt was not proof of descendant cleanup",
      );
    } catch (error) {
      lastFailure = error;
    }
  }
  throw new Error(
    "external evaluator Task cleanup was not proven after retry",
    { cause: lastFailure },
  );
};

/**
 * Keeps process-local evaluator ownership until a cleanup receipt proves that
 * descendants and their cgroup scope are gone. The underlying M1 discard is
 * explicitly retryable after a rejected or unproven cleanup attempt.
 */
export const cleanupFrameInputWindowEvaluatorOwnershipV1 = async <
  Ownership,
>(input: {
  readonly ownership: Ownership;
  readonly activeOwnerships: Set<Ownership>;
  readonly cleanup: (
    ownership: Ownership,
  ) => Promise<FrameInputWindowEvaluatorCleanupReceiptV1>;
}): Promise<void> => {
  if (!input.activeOwnerships.has(input.ownership)) {
    throw new Error("external evaluator Task ownership is not active");
  }
  await proveFrameInputWindowEvaluatorCleanupV1({
    cleanup: () => input.cleanup(input.ownership),
  });
  input.activeOwnerships.delete(input.ownership);
};

/**
 * Retains a setup-time cleanup owner until its retry contract proves that the
 * resources acquired before Task construction are gone.
 */
export const cleanupFrameInputWindowRetainedOwnershipV1 = async <
  Ownership,
>(input: {
  readonly ownership: Ownership;
  readonly activeOwnerships: Set<Ownership>;
  readonly cleanup: (ownership: Ownership) => Promise<void>;
}): Promise<void> => {
  if (!input.activeOwnerships.has(input.ownership)) {
    throw new Error("external evaluator setup-cleanup ownership is not active");
  }
  let lastFailure: unknown = new Error(
    "external evaluator setup cleanup was not attempted",
  );
  for (let attempt = 0; attempt < EVALUATOR_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      await input.cleanup(input.ownership);
      input.activeOwnerships.delete(input.ownership);
      return;
    } catch (error) {
      lastFailure = error;
    }
  }
  throw new Error(
    "external evaluator setup cleanup was not proven after retry",
    { cause: lastFailure },
  );
};

/**
 * Final release-test cleanup. The temporary root remains available for review
 * whenever any owned Task lacks cleanup proof.
 */
export const cleanupFrameInputWindowReleaseRootV1 = async <
  Ownership,
  RetainedOwnership = never,
>(input: {
  readonly activeEvaluatorOwnerships: Set<Ownership>;
  readonly cleanupEvaluator: (
    ownership: Ownership,
  ) => Promise<FrameInputWindowEvaluatorCleanupReceiptV1>;
  readonly activeRetainedCleanupOwnerships?: Set<RetainedOwnership> | undefined;
  readonly cleanupRetainedOwnership?:
    ((ownership: RetainedOwnership) => Promise<void>) | undefined;
  readonly cleanupProductTask?:
    (() => Promise<FrameInputWindowEvaluatorCleanupReceiptV1>) | undefined;
  readonly onProductCleanupProven?: (() => void) | undefined;
  readonly removeTemporaryRoot: () => Promise<void>;
}): Promise<void> => {
  const cleanupFailures: unknown[] = [];
  const evaluatorResults = await Promise.allSettled(
    [...input.activeEvaluatorOwnerships].map((ownership) =>
      cleanupFrameInputWindowEvaluatorOwnershipV1({
        ownership,
        activeOwnerships: input.activeEvaluatorOwnerships,
        cleanup: input.cleanupEvaluator,
      }),
    ),
  );
  for (const result of evaluatorResults) {
    if (result.status === "rejected") cleanupFailures.push(result.reason);
  }

  if (
    (input.activeRetainedCleanupOwnerships === undefined) !==
    (input.cleanupRetainedOwnership === undefined)
  ) {
    cleanupFailures.push(
      new Error("release retained-cleanup ownership is misconfigured"),
    );
  } else if (
    input.activeRetainedCleanupOwnerships !== undefined &&
    input.cleanupRetainedOwnership !== undefined
  ) {
    const activeRetainedCleanupOwnerships =
      input.activeRetainedCleanupOwnerships;
    const cleanupRetainedOwnership = input.cleanupRetainedOwnership;
    const retainedResults = await Promise.allSettled(
      [...activeRetainedCleanupOwnerships].map((ownership) =>
        cleanupFrameInputWindowRetainedOwnershipV1({
          ownership,
          activeOwnerships: activeRetainedCleanupOwnerships,
          cleanup: cleanupRetainedOwnership,
        }),
      ),
    );
    for (const result of retainedResults) {
      if (result.status === "rejected") cleanupFailures.push(result.reason);
    }
  }

  if (input.cleanupProductTask !== undefined) {
    try {
      await proveFrameInputWindowEvaluatorCleanupV1({
        cleanup: input.cleanupProductTask,
      });
      input.onProductCleanupProven?.();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  if (
    cleanupFailures.length > 0 ||
    input.activeEvaluatorOwnerships.size > 0 ||
    (input.activeRetainedCleanupOwnerships?.size ?? 0) > 0
  ) {
    throw new Error(
      "release cleanup was not proven; process-local ownership was retained and the temporary root was retained",
      { cause: cleanupFailures[0] },
    );
  }
  await input.removeTemporaryRoot();
};

export type FrameInputWindowRunnerInfrastructureCodeV1 =
  | "factory_failed"
  | "task_namespace_reused"
  | "tool_protocol_failed"
  | "tool_operation_failed"
  | "runtime_lineage_failed"
  | "runtime_cleanup_failed";

/**
 * A runner failure is evaluator infrastructure, never a game-task result.
 * The release evaluator catches this class and emits infrastructure_failure.
 */
export class FrameInputWindowRunnerInfrastructureError extends Error {
  public constructor(
    public readonly infrastructureCode: FrameInputWindowRunnerInfrastructureCodeV1,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FrameInputWindowRunnerInfrastructureError";
  }
}

class FrameInputWindowToolResponseError extends Error {
  public constructor(
    public readonly toolName: RunnerToolName,
    public readonly errorCode: VNextGameToolErrorCodeV1,
    public readonly responseMessage: string,
    public readonly details: JsonValue | undefined,
  ) {
    super(`${toolName} failed (${errorCode}): ${responseMessage}`);
    this.name = "FrameInputWindowToolResponseError";
  }
}

export const frameInputWindowProcessTickV1 = (
  requestedTimeUs: 75_000 | 250_000,
  fixedFps: 60 | 120,
): { readonly deltaUs: number; readonly requestedTick: number } => {
  const deltaUs = Math.round(1_000_000 / fixedFps);
  return Object.freeze({
    deltaUs,
    requestedTick: Math.ceil(requestedTimeUs / deltaUs),
  });
};

type RunnerOutputByTool = {
  readonly game_capabilities: GameCapabilitiesOutputV1;
  readonly game_launch: GameLaunchOutputV1;
  readonly game_query: GameQueryOutputV1;
  readonly game_input: GameInputOutputV1;
  readonly game_step: GameStepOutputV1;
  readonly game_stop: GameStopOutputV1;
};
type RunnerToolName = keyof RunnerOutputByTool;

const invokeSuccess = async <Name extends RunnerToolName>(input: {
  readonly port: VNextGameToolPort;
  readonly toolName: Name;
  readonly toolCallId: string;
  readonly toolInput: JsonValue;
  readonly signal?: AbortSignal | undefined;
}): Promise<RunnerOutputByTool[Name]> => {
  if (!validateGameToolInputV1(input.toolName, input.toolInput)) {
    throw new FrameInputWindowRunnerInfrastructureError(
      "tool_protocol_failed",
      `release runner generated invalid ${input.toolName} input`,
    );
  }
  let raw: unknown;
  try {
    raw = await input.port.invoke(
      {
        schemaVersion: 1,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        input: input.toolInput,
      } satisfies VNextGameToolPortRequestV1,
      input.signal,
    );
  } catch (error) {
    throw new FrameInputWindowRunnerInfrastructureError(
      "tool_operation_failed",
      `${input.toolName} transport failed`,
      { cause: error },
    );
  }
  if (!Check(VNextGameToolResponseV1Schema, raw)) {
    throw new FrameInputWindowRunnerInfrastructureError(
      "tool_protocol_failed",
      `${input.toolName} returned an invalid response envelope`,
    );
  }
  if (raw.toolCallId !== input.toolCallId) {
    throw new FrameInputWindowRunnerInfrastructureError(
      "tool_protocol_failed",
      `${input.toolName} response did not correlate to its toolCallId`,
    );
  }
  if (raw.outcome === "error") {
    throw new FrameInputWindowToolResponseError(
      input.toolName,
      raw.error.code,
      raw.error.message,
      raw.error.details === undefined
        ? undefined
        : JsonValueSchema.parse(raw.error.details),
    );
  }
  if (!validateGameToolOutputV1(input.toolName, raw.output)) {
    throw new FrameInputWindowRunnerInfrastructureError(
      "tool_protocol_failed",
      `${input.toolName} returned invalid tool-specific output`,
    );
  }
  return raw.output as RunnerOutputByTool[Name];
};

const sameRequestedPoint = (
  left: z.infer<typeof requestedPointSchema>,
  right: z.infer<typeof requestedPointSchema>,
): boolean =>
  left.clock === right.clock &&
  left.requestedTick === right.requestedTick &&
  left.requestedPhase === right.requestedPhase;

const runtimeLineageFailure = (message: string): never => {
  throw new FrameInputWindowRunnerInfrastructureError(
    "runtime_lineage_failed",
    message,
  );
};

const parseStep = (output: GameStepOutputV1) => {
  const result = stepProjectionSchema.safeParse(output);
  if (!result.success) {
    throw new FrameInputWindowRunnerInfrastructureError(
      "tool_protocol_failed",
      "game_step output did not contain strict runtime receipts",
      { cause: result.error },
    );
  }
  return result.data;
};

const droppedCount = (step: z.infer<typeof stepProjectionSchema>): number => {
  const recordedLoss = step.loss
    .filter((entry) => entry.kind === "dropped" || entry.kind === "overwritten")
    .reduce((total, entry) => total + entry.count, 0);
  const coverageLoss = step.coverage.reduce(
    (total, entry) => total + entry.droppedRecords + entry.overwrittenRecords,
    0,
  );
  const protocolLoss = step.stepReceipts.reduce(
    (total, entry) =>
      total +
      entry.runtime.observationHealth.droppedEvents +
      entry.runtime.observationHealth.truncatedEvents,
    0,
  );
  // These are overlapping views of the same execution, so summing would
  // double-count. A nonzero maximum preserves any reported loss.
  return Math.max(recordedLoss, coverageLoss, protocolLoss);
};

type CaptureEvidence = Pick<
  z.infer<typeof stepProjectionSchema>,
  "coverage" | "loss"
>;

const captureDroppedCount = (capture: CaptureEvidence): number =>
  Math.max(
    capture.loss
      .filter(
        (entry) => entry.kind === "dropped" || entry.kind === "overwritten",
      )
      .reduce((total, entry) => total + entry.count, 0),
    capture.coverage.reduce(
      (total, entry) => total + entry.droppedRecords + entry.overwrittenRecords,
      0,
    ),
  );

const captureIsComplete = (capture: CaptureEvidence): boolean =>
  capture.coverage.some(
    (entry) => entry.channel === "error" && entry.status === "full",
  ) &&
  capture.coverage.every(
    (entry) => entry.status === "full" && entry.limitations.length === 0,
  ) &&
  capture.loss.length === 0;

const stepObservationIsComplete = (
  step: z.infer<typeof stepProjectionSchema>,
): boolean =>
  captureIsComplete(step) &&
  step.stepReceipts.every(
    (entry) =>
      entry.runtime.observationHealth.droppedEvents === 0 &&
      entry.runtime.observationHealth.truncatedEvents === 0 &&
      !entry.runtime.observationHealth.backpressure,
  );

const asInfrastructure = (
  error: unknown,
  fallbackCode: FrameInputWindowRunnerInfrastructureCodeV1,
  fallbackMessage: string,
): FrameInputWindowRunnerInfrastructureError =>
  error instanceof FrameInputWindowRunnerInfrastructureError
    ? error
    : new FrameInputWindowRunnerInfrastructureError(
        fallbackCode,
        error instanceof FrameInputWindowToolResponseError
          ? error.message
          : fallbackMessage,
        { cause: error },
      );

const cleanupInfrastructureFailure = (input: {
  readonly message: string;
  readonly error: unknown;
  readonly priorFailure?: Error | undefined;
}): FrameInputWindowRunnerInfrastructureError =>
  new FrameInputWindowRunnerInfrastructureError(
    "runtime_cleanup_failed",
    input.message,
    {
      cause:
        input.priorFailure === undefined
          ? input.error
          : new AggregateError(
              [input.priorFailure, input.error],
              "scenario execution and cleanup both failed",
            ),
    },
  );

const throwAfterTaskClose = async (input: {
  readonly task: FrameInputWindowEvaluatorTaskV1;
  readonly failure: FrameInputWindowRunnerInfrastructureError;
}): Promise<never> => {
  try {
    await input.task.close();
  } catch (error) {
    throw cleanupInfrastructureFailure({
      message:
        "external evaluator Task cleanup was not proven after factory validation failed",
      error,
      priorFailure: input.failure,
    });
  }
  throw input.failure;
};

interface SealedRuntimeDiagnosticsV1 {
  readonly protocolErrors: readonly string[];
  readonly capture: CaptureEvidence;
  readonly terminalQueryComplete: boolean;
}

const collectSealedRuntimeDiagnosticsV1 = async (input: {
  readonly task: FrameInputWindowEvaluatorTaskV1;
  readonly prefix: string;
  readonly executionId: string;
  readonly runtimeId: string;
  readonly buildId: string;
  readonly sourceId: string;
}): Promise<SealedRuntimeDiagnosticsV1> => {
  let cursor: string | undefined;
  let indexId: string | undefined;
  let rawRecordHash: string | undefined;
  let terminalQueryComplete = false;
  let reachedTerminalPage = false;
  let capture: CaptureEvidence | undefined;
  const protocolErrors: string[] = [];
  const observedRows = new Set<string>();

  for (let page = 0; page < MAX_QUERY_PAGES; page += 1) {
    const output = await invokeSuccess({
      port: input.task.port,
      toolName: GAME_TOOL_NAMES_V1.query,
      toolCallId: `${input.prefix}:query:${page}`,
      toolInput: {
        schemaVersion: 1,
        taskId: input.task.taskId,
        executionId: input.executionId,
        ...(indexId === undefined ? {} : { indexId }),
        select: "events",
        limit: QUERY_PAGE_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      },
      signal: undefined,
    });
    const result = output.result;
    if (
      result.taskId !== input.task.taskId ||
      result.executionId !== input.executionId ||
      result.runtimeId !== input.runtimeId ||
      result.buildId !== input.buildId ||
      result.sourceId !== input.sourceId ||
      result.query.taskId !== input.task.taskId ||
      result.query.executionId !== input.executionId ||
      result.query.limit !== QUERY_PAGE_LIMIT ||
      result.query.cursor !== (cursor ?? null) ||
      (indexId !== undefined && result.indexId !== indexId) ||
      (rawRecordHash !== undefined && result.rawRecordHash !== rawRecordHash)
    ) {
      runtimeLineageFailure(
        "game_query detached sealed diagnostics from the evaluated execution",
      );
    }
    indexId = result.indexId;
    rawRecordHash = result.rawRecordHash;
    capture = {
      coverage: result.coverage,
      loss: result.loss,
    };
    for (const row of result.rows) {
      if (observedRows.has(row.rawEventId)) {
        runtimeLineageFailure(
          "game_query repeated a raw event across diagnostic pages",
        );
      }
      observedRows.add(row.rawEventId);
      if (row.kind === "error") {
        protocolErrors.push(`runtime error event ${row.rawEventId}`);
      }
    }
    if (result.nextCursor === null) {
      reachedTerminalPage = true;
      terminalQueryComplete = !result.incomplete;
      break;
    }
    if (result.nextCursor === cursor) {
      runtimeLineageFailure("game_query did not advance its diagnostic cursor");
    }
    cursor = result.nextCursor;
  }
  if (!reachedTerminalPage) {
    throw new FrameInputWindowRunnerInfrastructureError(
      "tool_protocol_failed",
      "game_query exceeded the bounded sealed-diagnostic pagination limit",
    );
  }
  if (capture === undefined) {
    throw new FrameInputWindowRunnerInfrastructureError(
      "tool_protocol_failed",
      "game_query returned no sealed diagnostic capture evidence",
    );
  }
  return {
    protocolErrors,
    capture,
    terminalQueryComplete,
  };
};

type CandidateFailureStage = "launch" | "step";

const classifyCandidateExecutionFailure = (input: {
  readonly scenario: FrameInputWindowScenarioV1;
  readonly stage: CandidateFailureStage | undefined;
  readonly error: unknown;
  readonly signal?: AbortSignal | undefined;
}): Omit<
  FrameInputWindowCandidateExecutionFailureEvidenceV1,
  "cleanupProven"
> | null => {
  if (
    input.scenario.subject !== "candidate" ||
    input.stage === undefined ||
    input.signal?.aborted === true ||
    !(input.error instanceof FrameInputWindowToolResponseError) ||
    input.error.toolName !==
      (input.stage === "launch"
        ? GAME_TOOL_NAMES_V1.launch
        : GAME_TOOL_NAMES_V1.step)
  ) {
    return null;
  }
  if (
    input.error.errorCode !== "runtime_crashed" &&
    input.error.errorCode !== "runtime_unavailable" &&
    input.error.errorCode !== "operation_failed"
  ) {
    return null;
  }
  const proof = candidateFailureProofSchema.safeParse(input.error.details);
  if (
    !proof.success ||
    proof.data.stage !== input.stage ||
    proof.data.sourceHash !== input.scenario.expectedSourceHash
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    scenarioId: input.scenario.scenarioId,
    stage: input.stage,
    toolName:
      input.stage === "launch"
        ? GAME_TOOL_NAMES_V1.launch
        : GAME_TOOL_NAMES_V1.step,
    error: {
      code: input.error.errorCode,
      message: input.error.responseMessage,
    },
    expectedSourceHash: input.scenario.expectedSourceHash,
    requestedControls: {
      fixedFps: input.scenario.fixedFps,
      physicsTicksPerSecond: input.scenario.physicsTicksPerSecond,
      maxTicks: MAX_SCENARIO_TICKS,
      inputTimeUs: input.scenario.inputTimeUs,
    },
  };
};

/**
 * Adapts the atomic task-owned game port to the external release evaluator.
 * Every scenario gets a distinct Task, a fresh runtime, and an explicitly
 * sealed execution. It observes receipts; it does not decide acceptance.
 */
export const createFrameInputWindowGameToolScenarioRunnerV1 = (input: {
  readonly factory: FrameInputWindowEvaluatorTaskFactoryV1;
}): FrameInputWindowScenarioRunnerV1 => {
  const usedTaskIds = new Set<string>();
  let sequence = 0;

  return Object.freeze({
    async run(
      scenarioInput: FrameInputWindowScenarioV1,
      signal?: AbortSignal,
    ): Promise<FrameInputWindowObservationV1> {
      const scenario = FrameInputWindowScenarioV1Schema.parse(scenarioInput);
      if (signal?.aborted === true) {
        throw new FrameInputWindowRunnerInfrastructureError(
          "factory_failed",
          "external evaluator was aborted before Task creation",
          { cause: signal.reason },
        );
      }
      let task: FrameInputWindowEvaluatorTaskV1;
      try {
        task = await input.factory.create(scenario, signal);
      } catch (error) {
        throw asInfrastructure(
          error,
          "factory_failed",
          "external evaluator Task creation failed",
        );
      }
      if (!validateGameTaskIdV1(task.taskId)) {
        return throwAfterTaskClose({
          task,
          failure: new FrameInputWindowRunnerInfrastructureError(
            "factory_failed",
            "external evaluator factory returned an invalid Task ID",
          ),
        });
      }
      if (usedTaskIds.has(task.taskId)) {
        return throwAfterTaskClose({
          task,
          failure: new FrameInputWindowRunnerInfrastructureError(
            "task_namespace_reused",
            "factory reused evaluator Task namespace across scenarios",
          ),
        });
      }
      usedTaskIds.add(task.taskId);

      const prefix = `${scenario.scenarioId}:${sequence++}`;
      let runtimeId: string | undefined;
      let mainFailure: FrameInputWindowRunnerInfrastructureError | undefined;
      let candidateFailure:
        | Omit<
            FrameInputWindowCandidateExecutionFailureEvidenceV1,
            "cleanupProven"
          >
        | undefined;
      let candidateFailureStage: CandidateFailureStage | undefined;
      let observation: FrameInputWindowObservationV1 | undefined;
      let observationBasis:
        | Omit<
            FrameInputWindowObservationV1,
            "protocolErrors" | "droppedEventCount" | "observationComplete"
          >
        | undefined;
      let observationStep: z.infer<typeof stepProjectionSchema> | undefined;
      let launchExecutionId: string | undefined;
      let launchBuildId: string | undefined;
      let launchSourceId: string | undefined;
      try {
        const capabilitiesOutput = await invokeSuccess({
          port: task.port,
          toolName: GAME_TOOL_NAMES_V1.capabilities,
          toolCallId: `${prefix}:capabilities`,
          toolInput: { schemaVersion: 1, taskId: task.taskId },
          signal,
        });
        const build = VNextBuildV1Schema.safeParse(capabilitiesOutput.build);
        if (!build.success) {
          throw new FrameInputWindowRunnerInfrastructureError(
            "tool_protocol_failed",
            "game_capabilities returned an invalid Build resource",
            { cause: build.error },
          );
        }
        if (
          capabilitiesOutput.taskId !== task.taskId ||
          build.data.taskId !== task.taskId
        ) {
          runtimeLineageFailure(
            "game_capabilities detached Build from the evaluator Task",
          );
        }
        if (build.data.sourceHash !== scenario.expectedSourceHash) {
          runtimeLineageFailure(
            "game_capabilities source identity did not match the requested subject",
          );
        }

        candidateFailureStage = "launch";
        const launchOutput = await invokeSuccess({
          port: task.port,
          toolName: GAME_TOOL_NAMES_V1.launch,
          toolCallId: `${prefix}:launch`,
          toolInput: {
            schemaVersion: 1,
            taskId: task.taskId,
            buildId: build.data.buildId,
            controls: {
              fixedFps: scenario.fixedFps,
              physicsTicksPerSecond: scenario.physicsTicksPerSecond,
              maxTicks: MAX_SCENARIO_TICKS,
            },
          },
          signal,
        });
        candidateFailureStage = undefined;
        runtimeId = launchOutput.runtimeId;
        launchExecutionId = launchOutput.executionId;
        const launchBuild = launchBuildSchema.safeParse(launchOutput.build);
        const launchRuntime = VNextRuntimeV1Schema.safeParse(
          launchOutput.runtime,
        );
        const launchControls = realizedControlsSchema.safeParse(
          launchOutput.controls,
        );
        if (
          !launchBuild.success ||
          !launchRuntime.success ||
          !launchControls.success
        ) {
          throw new FrameInputWindowRunnerInfrastructureError(
            "tool_protocol_failed",
            "game_launch omitted strict build, runtime, or realized controls",
          );
        }
        launchBuildId = launchBuild.data.buildId;
        launchSourceId = launchBuild.data.sourceId;
        if (
          launchRuntime.data.status !== "running" ||
          launchRuntime.data.taskId !== task.taskId ||
          launchRuntime.data.runtimeId !== launchOutput.runtimeId ||
          launchRuntime.data.buildId !== build.data.buildId ||
          launchBuild.data.buildId !== build.data.buildId ||
          launchBuild.data.sourceId !== build.data.sourceId ||
          launchBuild.data.sourceHash !== scenario.expectedSourceHash
        ) {
          runtimeLineageFailure(
            "game_launch runtime lineage or source identity did not match capabilities",
          );
        }
        const launchClock = VNextClockPositionV1Schema.safeParse(
          launchOutput.clocks,
        );
        if (
          !launchClock.success ||
          launchClock.data.processFrame !== 0 ||
          launchClock.data.physicsTick !== 0 ||
          launchClock.data.simulationTimeUs !== 0 ||
          launchClock.data.hostMonotonicUs !== 0 ||
          launchClock.data.renderFrame !== null
        ) {
          runtimeLineageFailure(
            "game_launch did not return a fresh zero-position runtime clock",
          );
        }
        if (
          launchControls.data.fixedFps !== scenario.fixedFps ||
          launchControls.data.physicsTicksPerSecond !==
            scenario.physicsTicksPerSecond ||
          launchControls.data.maxTicks !== MAX_SCENARIO_TICKS ||
          launchControls.data.stepsUsed !== 0
        ) {
          runtimeLineageFailure(
            "game_launch did not realize the requested evaluator controls",
          );
        }

        const horizonTimeUs =
          scenario.inputTimeUs ?? NO_INPUT_OBSERVATION_TIME_US;
        const schedule = frameInputWindowProcessTickV1(
          horizonTimeUs,
          scenario.fixedFps,
        );
        const requestedPoint = requestedPointSchema.parse({
          clock: "process_frame",
          requestedTick: schedule.requestedTick,
          requestedPhase: "process_frame_start",
        });
        let requestId: string | undefined;
        if (scenario.inputTimeUs !== null) {
          const inputOutput = await invokeSuccess({
            port: task.port,
            toolName: GAME_TOOL_NAMES_V1.input,
            toolCallId: `${prefix}:input`,
            toolInput: {
              schemaVersion: 1,
              taskId: task.taskId,
              runtimeId,
              action: "attempt_jump",
              requested: requestedPoint,
            },
            signal,
          });
          const returnedPoint = requestedPointSchema.safeParse(
            inputOutput.requested,
          );
          if (
            inputOutput.runtimeId !== runtimeId ||
            inputOutput.action !== "attempt_jump" ||
            inputOutput.queued !== true ||
            inputOutput.realized !== null ||
            !returnedPoint.success ||
            !sameRequestedPoint(returnedPoint.data, requestedPoint)
          ) {
            runtimeLineageFailure(
              "game_input did not preserve the requested schedule and runtime",
            );
          }
          requestId = inputOutput.requestId;
        }

        const stepCount = schedule.requestedTick + POST_OBSERVATION_FRAMES;
        candidateFailureStage = "step";
        const stepOutput = await invokeSuccess({
          port: task.port,
          toolName: GAME_TOOL_NAMES_V1.step,
          toolCallId: `${prefix}:step`,
          toolInput: {
            schemaVersion: 1,
            taskId: task.taskId,
            runtimeId,
            clock: "process_frame",
            count: stepCount,
          },
          signal,
        });
        candidateFailureStage = undefined;
        const step = parseStep(stepOutput);
        if (
          step.runtimeId !== runtimeId ||
          step.executionId !== launchOutput.executionId ||
          step.requested.count !== stepCount ||
          step.realized.requestedClockProgress !== stepCount ||
          step.realized.overshoot !== 0 ||
          step.stepReceipts.length !== stepCount ||
          step.realized.processFrames !== step.clocks.processFrame ||
          step.realized.physicsTicks !== step.clocks.physicsTick
        ) {
          runtimeLineageFailure(
            "game_step clocks, receipts, or runtime lineage were inconsistent",
          );
        }
        const realizedFrames = step.stepReceipts.reduce(
          (total, entry) => total + entry.runtime.idleFramesExecuted,
          0,
        );
        const realizedPhysicsTicks = step.stepReceipts.reduce(
          (total, entry) => total + entry.runtime.physicsTicksExecuted,
          0,
        );
        const realizedSimulationTimeUs = step.stepReceipts.reduce(
          (total, entry) => total + entry.realizedDeltaUs,
          0,
        );
        if (
          realizedFrames !== step.realized.processFrames ||
          realizedPhysicsTicks !== step.realized.physicsTicks ||
          realizedSimulationTimeUs !== step.clocks.simulationTimeUs
        ) {
          runtimeLineageFailure(
            "game_step aggregate receipt clocks did not match realized clocks",
          );
        }

        let realizedInputTimeUs: number | null = null;
        if (requestId === undefined) {
          if (step.receipts.length !== 0 || step.pendingInputs.length !== 0) {
            runtimeLineageFailure(
              "no-input scenario produced an input receipt or pending input",
            );
          }
        } else {
          const matching = step.receipts.filter(
            (receipt) => receipt.requestId === requestId,
          );
          if (
            matching.length !== 1 ||
            !sameRequestedPoint(matching[0]!.requested, requestedPoint) ||
            step.pendingInputs.some(
              (pending) => pending.requestId === requestId,
            )
          ) {
            runtimeLineageFailure(
              "game_step did not correlate exactly one realized input receipt",
            );
          }
          const realized = matching[0]!.realized;
          const cumulativeRealizedInputTimeUs = step.stepReceipts
            .slice(0, realized.processFrame)
            .reduce((total, entry) => total + entry.realizedDeltaUs, 0);
          if (
            realized.processFrame < requestedPoint.requestedTick ||
            realized.processFrame > step.clocks.processFrame ||
            realized.physicsTick > step.clocks.physicsTick ||
            realized.simulationTimeUs > step.clocks.simulationTimeUs ||
            realized.simulationTimeUs !== cumulativeRealizedInputTimeUs ||
            realized.hostMonotonicUs > step.clocks.hostMonotonicUs ||
            (realized.renderFrame !== null &&
              step.clocks.renderFrame !== null &&
              realized.renderFrame > step.clocks.renderFrame)
          ) {
            runtimeLineageFailure(
              "realized input receipt exceeded the execution's five-domain clock position",
            );
          }
          realizedInputTimeUs = realized.simulationTimeUs;
        }

        const jumping = step.state.values["player.jumping"];
        if (typeof jumping !== "boolean") {
          throw new FrameInputWindowRunnerInfrastructureError(
            "tool_protocol_failed",
            "game_step did not observe boolean player.jumping state",
          );
        }
        observationStep = step;
        observationBasis = {
          schemaVersion: 1,
          scenarioId: scenario.scenarioId,
          sourceHash: scenario.expectedSourceHash,
          realizedFixedFps: launchControls.data.fixedFps,
          realizedPhysicsTicksPerSecond:
            launchControls.data.physicsTicksPerSecond,
          requestedInputTimeUs: scenario.inputTimeUs,
          realizedInputTimeUs,
          jumping,
          processFrames: step.clocks.processFrame,
          physicsTicks: step.clocks.physicsTick,
          runtimeStatus: "completed",
        };
      } catch (error) {
        candidateFailure =
          classifyCandidateExecutionFailure({
            scenario,
            stage: candidateFailureStage,
            error,
            signal,
          }) ?? undefined;
        if (candidateFailure === undefined) {
          mainFailure = asInfrastructure(
            error,
            "tool_operation_failed",
            "external game scenario execution failed",
          );
        }
      } finally {
        if (runtimeId !== undefined) {
          let stopOutput: GameStopOutputV1 | undefined;
          try {
            stopOutput = await invokeSuccess({
              port: task.port,
              toolName: GAME_TOOL_NAMES_V1.stop,
              toolCallId: `${prefix}:stop`,
              toolInput: {
                schemaVersion: 1,
                taskId: task.taskId,
                runtimeId,
              },
              signal: undefined,
            });
            const stoppedRuntime = VNextRuntimeV1Schema.safeParse(
              stopOutput.runtime,
            );
            if (
              stopOutput.sealed !== true ||
              stopOutput.runtimeId !== runtimeId ||
              stopOutput.executionId !== launchExecutionId ||
              !stoppedRuntime.success ||
              stoppedRuntime.data.taskId !== task.taskId ||
              stoppedRuntime.data.runtimeId !== runtimeId ||
              (stoppedRuntime.data.status !== "stopped" &&
                !(
                  candidateFailure !== undefined &&
                  stoppedRuntime.data.status === "failed"
                ))
            ) {
              throw new Error(
                "game_stop did not return a sealed cleanup terminal runtime",
              );
            }
          } catch (error) {
            candidateFailure = undefined;
            mainFailure = cleanupInfrastructureFailure({
              message:
                "external evaluator could not seal the runtime execution",
              error,
              priorFailure: mainFailure,
            });
          }
          if (
            mainFailure === undefined &&
            candidateFailure === undefined &&
            observationBasis !== undefined &&
            observationStep !== undefined &&
            launchExecutionId !== undefined &&
            launchBuildId !== undefined &&
            launchSourceId !== undefined &&
            stopOutput !== undefined
          ) {
            try {
              const diagnostics = await collectSealedRuntimeDiagnosticsV1({
                task,
                prefix,
                executionId: launchExecutionId,
                runtimeId,
                buildId: launchBuildId,
                sourceId: launchSourceId,
              });
              const stopCapture: CaptureEvidence = {
                coverage: stopOutput.coverage,
                loss: stopOutput.loss,
              };
              observation = FrameInputWindowObservationV1Schema.parse({
                ...observationBasis,
                protocolErrors: diagnostics.protocolErrors,
                droppedEventCount: Math.max(
                  droppedCount(observationStep),
                  captureDroppedCount(stopCapture),
                  captureDroppedCount(diagnostics.capture),
                ),
                observationComplete:
                  stepObservationIsComplete(observationStep) &&
                  captureIsComplete(stopCapture) &&
                  captureIsComplete(diagnostics.capture) &&
                  diagnostics.terminalQueryComplete,
              });
            } catch (error) {
              mainFailure = asInfrastructure(
                error,
                "tool_operation_failed",
                "external evaluator could not inspect sealed runtime diagnostics",
              );
            }
          }
        }
        try {
          await task.close();
        } catch (error) {
          candidateFailure = undefined;
          mainFailure = cleanupInfrastructureFailure({
            message: "external evaluator Task cleanup was not proven",
            error,
            priorFailure: mainFailure,
          });
        }
      }
      if (mainFailure !== undefined) throw mainFailure;
      if (candidateFailure !== undefined) {
        throw new FrameInputWindowCandidateExecutionError({
          ...candidateFailure,
          cleanupProven: true,
        });
      }
      if (observation === undefined) {
        throw new FrameInputWindowRunnerInfrastructureError(
          "tool_operation_failed",
          "external evaluator produced no observation",
        );
      }
      return observation;
    },
  });
};
