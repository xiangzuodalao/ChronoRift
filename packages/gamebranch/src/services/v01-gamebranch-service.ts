import {
  BranchSpecSchema,
  CheckpointSchema,
  DiagnosisProposalSchema,
  DiagnosisVerdictSchema,
  EvidenceCapsuleSchema,
  ExecutionComparisonSchema,
  ExecutionLogSchema,
  FrozenContractSchema,
  InputTraceSchema,
  asBranchId,
  asCapsuleId,
  asComparisonId,
  asContractId,
  asEventId,
  asExecutionId,
  asInputTraceId,
  asVerdictId,
  type ArtifactReference,
  type BaselineBranchSpec,
  type BranchControls,
  type BranchId,
  type BranchSpec,
  type CapsuleId,
  type Checkpoint,
  type CheckpointId,
  type ConclusionBlocker,
  type ContractEvaluation,
  type ContractId,
  type DiagnosisProposal,
  type DiagnosisVerdict,
  type EventId,
  type EvidenceCapsule,
  type ExecutionComparison,
  type ExecutionId,
  type ExecutionLog,
  type ExecutionTelemetryEvent,
  type FrozenContract,
  type InputTrace,
  type InputTraceId,
  type JsonValue,
  type ProposalId,
  type RunId,
  type StateSnapshot,
  type StepReceipt,
  type V01EnvironmentEventDraft,
} from "@chronorift/domain";

import type { GameEnvironmentFactoryPort } from "../ports/game-environment.js";
import type { ClockPort, V01IdGeneratorPort } from "../ports/support.js";
import type { V01ArtifactRepositoryPort } from "../ports/v01-artifact-repository.js";
import { canonicalStringify, digestJson, jsonEqual } from "./canonical.js";
import {
  computeExecutionTimelineDigest,
  firstExecutionDivergenceTick,
} from "./v01-canonical.js";

export type FrozenContractInput = Omit<FrozenContract, "contractId">;

export interface CreateV01BaselineRequest {
  readonly runId: RunId;
  readonly contractId: ContractId;
  readonly checkpointId: CheckpointId;
  readonly inputTraceId: InputTraceId;
  readonly controls: BranchControls;
}

export interface ReplayExecutionResult {
  readonly execution: ExecutionLog;
  readonly matches: boolean;
  readonly sourceDigest: string;
  readonly replayDigest: string;
}

export interface InterventionExecutionResult {
  readonly branch: BranchSpec;
  readonly execution: ExecutionLog;
}

export type V01GameBranchErrorCode =
  | "INVALID_CONTRACT"
  | "INVALID_BRANCH"
  | "INVALID_EXECUTION"
  | "INVALID_INTERVENTION"
  | "INVALID_PROPOSAL"
  | "RUNTIME_PROTOCOL_ERROR";

export class V01GameBranchError extends Error {
  public override readonly name = "V01GameBranchError";

  public constructor(
    public readonly code: V01GameBranchErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const contractContent = (contract: FrozenContractInput): JsonValue => ({
  schemaVersion: contract.schemaVersion,
  fixture: contract.fixture,
  authority: {
    status: contract.authority.status,
    approvedBy: contract.authority.approvedBy,
  },
  rule: {
    trigger: {
      kind: contract.rule.trigger.kind,
      source: contract.rule.trigger.source,
      name: contract.rule.trigger.name,
    },
    expectation: {
      kind: contract.rule.expectation.kind,
      path: contract.rule.expectation.path,
      value: contract.rule.expectation.value,
    },
    withinTicks: contract.rule.withinTicks,
    inclusive: contract.rule.inclusive,
  },
});

export const contractIdFor = (contract: FrozenContractInput): ContractId =>
  asContractId(`contract:${digestJson(contractContent(contract))}`);

const withoutContractId = (contract: FrozenContract): FrozenContractInput => ({
  schemaVersion: contract.schemaVersion,
  fixture: contract.fixture,
  authority: contract.authority,
  rule: contract.rule,
});

const assertFrozenContract = (contract: FrozenContract): FrozenContract => {
  const parsed = FrozenContractSchema.parse(contract);
  if (parsed.authority.status !== "frozen") {
    throw new V01GameBranchError(
      "INVALID_CONTRACT",
      `Contract ${parsed.contractId} is not frozen`,
    );
  }
  const expected = contractIdFor(withoutContractId(parsed));
  if (expected !== parsed.contractId) {
    throw new V01GameBranchError(
      "INVALID_CONTRACT",
      `Contract content hash mismatch: expected ${expected}, received ${parsed.contractId}`,
    );
  }
  return parsed;
};

export const isFrozenContractAuthentic = (
  contract: FrozenContract,
): boolean => {
  try {
    assertFrozenContract(contract);
    return true;
  } catch {
    return false;
  }
};

const traceContent = (trace: InputTrace): JsonValue => ({
  schemaVersion: trace.schemaVersion,
  scheduleBasis: trace.scheduleBasis,
  inputs: trace.inputs.map((input) => ({
    relativeTick: input.relativeTick,
    order: input.order,
    action: input.action,
    ...(input.target === undefined ? {} : { target: input.target }),
    payload: input.payload,
  })),
});

const expectedTraceId = (trace: InputTrace): InputTraceId =>
  asInputTraceId(`trace:${digestJson(traceContent(trace))}`);

const assertContentAddressedTrace = (trace: InputTrace): InputTrace => {
  const parsed = InputTraceSchema.parse(trace);
  const expected = expectedTraceId(parsed);
  if (expected !== parsed.inputTraceId) {
    throw new V01GameBranchError(
      "INVALID_BRANCH",
      `Input trace content hash mismatch: expected ${expected}, received ${parsed.inputTraceId}`,
    );
  }
  return parsed;
};

const stateDigest = (state: StateSnapshot): string =>
  digestJson(state as unknown as JsonValue);

const observe = (
  state: StateSnapshot,
  path: string,
): { readonly present: boolean; readonly value?: JsonValue } =>
  Object.prototype.hasOwnProperty.call(state.values, path)
    ? { present: true, value: state.values[path] ?? null }
    : { present: false };

const inputLocalId = (tick: number, order: number): string =>
  `input:${tick}:${order}`;

const sameNumbers = (
  left: readonly number[],
  right: readonly number[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const causedBy = (
  localId: string | undefined,
  eventIdsByLocalId: ReadonlyMap<string, EventId>,
): { readonly causedByEventId?: EventId } => {
  if (localId === undefined) return {};
  const eventId = eventIdsByLocalId.get(localId);
  if (eventId === undefined) {
    throw new V01GameBranchError(
      "RUNTIME_PROTOCOL_ERROR",
      `Unresolved event causation localId ${localId}`,
    );
  }
  return { causedByEventId: eventId };
};

const materializeDraft = (
  draft: V01EnvironmentEventDraft,
  common: {
    readonly eventId: EventId;
    readonly executionId: ExecutionId;
    readonly runId: RunId;
    readonly branchId: BranchId;
    readonly seq: number;
    readonly tick: number;
    readonly simTimeUs: number;
  },
  eventIdsByLocalId: ReadonlyMap<string, EventId>,
): ExecutionTelemetryEvent => {
  const base = {
    schemaVersion: 1 as const,
    ...common,
    ...causedBy(draft.causedByLocalId, eventIdsByLocalId),
  };
  switch (draft.kind) {
    case "signal":
      return {
        ...base,
        kind: draft.kind,
        source: draft.source,
        name: draft.name,
        arguments: draft.arguments,
      };
    case "signal_delivery": {
      const cause = causedBy(
        draft.causedByLocalId,
        eventIdsByLocalId,
      ).causedByEventId;
      if (cause === undefined) {
        throw new V01GameBranchError(
          "RUNTIME_PROTOCOL_ERROR",
          "Signal delivery must cite its emitted signal",
        );
      }
      return {
        ...base,
        kind: draft.kind,
        causedByEventId: cause,
        source: draft.source,
        name: draft.name,
        receiver: draft.receiver,
        delivered: draft.delivered,
        ...(draft.failureReason === undefined
          ? {}
          : { failureReason: draft.failureReason }),
      };
    }
    case "property_changed":
      return {
        ...base,
        kind: draft.kind,
        path: draft.path,
        before: draft.before,
        after: draft.after,
      };
    case "log":
      return {
        ...base,
        kind: draft.kind,
        level: draft.level,
        source: draft.source,
        message: draft.message,
        fields: draft.fields,
      };
  }
};

const evaluateContract = (
  contract: FrozenContract,
  events: readonly ExecutionTelemetryEvent[],
  statesByTick: ReadonlyMap<number, StateSnapshot>,
): ContractEvaluation => {
  const trigger = events.find(
    (event) =>
      event.kind === "signal" &&
      event.source === contract.rule.trigger.source &&
      event.name === contract.rule.trigger.name,
  );
  if (trigger === undefined) {
    throw new V01GameBranchError(
      "INVALID_EXECUTION",
      "Execution did not emit the Contract trigger",
    );
  }
  const deadlineTick = trigger.tick + contract.rule.withinTicks;
  const satisfied = events.find(
    (event) =>
      event.kind === "property_changed" &&
      event.seq > trigger.seq &&
      event.tick <= deadlineTick &&
      event.path === contract.rule.expectation.path &&
      jsonEqual(event.after, contract.rule.expectation.value),
  );
  if (satisfied !== undefined) {
    return {
      status: "pass",
      triggerEventId: trigger.eventId,
      triggerTick: trigger.tick,
      deadlineTick,
      observed: { present: true, value: contract.rule.expectation.value },
      satisfiedTick: satisfied.tick,
    };
  }

  const deadlineState = statesByTick.get(deadlineTick);
  const lastState = [...statesByTick.entries()]
    .filter(([tick]) => tick >= trigger.tick && tick <= deadlineTick)
    .sort(([left], [right]) => right - left)[0]?.[1];
  return {
    status: deadlineState === undefined ? "incomplete" : "fail",
    triggerEventId: trigger.eventId,
    triggerTick: trigger.tick,
    deadlineTick,
    observed: observe(
      deadlineState ?? lastState ?? { values: {} },
      contract.rule.expectation.path,
    ),
  };
};

const recomputeContractEvaluation = (
  contract: FrozenContract,
  startState: StateSnapshot,
  execution: ExecutionLog,
): ContractEvaluation | undefined => {
  const trigger = execution.events.find(
    (event) =>
      event.kind === "signal" &&
      event.source === contract.rule.trigger.source &&
      event.name === contract.rule.trigger.name,
  );
  if (trigger === undefined) return undefined;

  const deadlineTick = trigger.tick + contract.rule.withinTicks;
  const satisfied = execution.events.find(
    (event) =>
      event.kind === "property_changed" &&
      event.seq > trigger.seq &&
      event.tick <= deadlineTick &&
      event.path === contract.rule.expectation.path &&
      jsonEqual(event.after, contract.rule.expectation.value),
  );
  let observed = observe(startState, contract.rule.expectation.path);
  for (const event of execution.events) {
    if (
      event.kind === "property_changed" &&
      event.tick <= deadlineTick &&
      event.path === contract.rule.expectation.path
    ) {
      observed = { present: true, value: event.after };
    }
  }
  if (satisfied !== undefined) {
    return {
      status: "pass",
      triggerEventId: trigger.eventId,
      triggerTick: trigger.tick,
      deadlineTick,
      observed,
      satisfiedTick: satisfied.tick,
    };
  }
  return {
    status: execution.stepReceipts.some(
      (receipt) => receipt.realizedTick === deadlineTick,
    )
      ? "fail"
      : "incomplete",
    triggerEventId: trigger.eventId,
    triggerTick: trigger.tick,
    deadlineTick,
    observed,
  };
};

const evaluationsEqual = (
  left: ContractEvaluation,
  right: ContractEvaluation,
): boolean =>
  canonicalStringify(left as unknown as JsonValue) ===
  canonicalStringify(right as unknown as JsonValue);

const evaluationSemanticsEqual = (
  left: ContractEvaluation,
  right: ContractEvaluation,
): boolean =>
  canonicalStringify({
    status: left.status,
    triggerTick: left.triggerTick,
    deadlineTick: left.deadlineTick,
    observed: {
      present: left.observed.present,
      ...(left.observed.value === undefined
        ? {}
        : { value: left.observed.value }),
    },
    satisfiedTick: left.satisfiedTick ?? null,
  }) ===
  canonicalStringify({
    status: right.status,
    triggerTick: right.triggerTick,
    deadlineTick: right.deadlineTick,
    observed: {
      present: right.observed.present,
      ...(right.observed.value === undefined
        ? {}
        : { value: right.observed.value }),
    },
    satisfiedTick: right.satisfiedTick ?? null,
  });

const checkpointMatchesExecution = (
  start: Checkpoint,
  final: Checkpoint,
  execution: ExecutionLog,
  contract: FrozenContract,
): boolean => {
  if (execution.status !== "completed") return false;
  const lastReceipt = execution.stepReceipts.at(-1);
  if (lastReceipt === undefined) return false;
  const expectedSimTimeUs =
    execution.restoreReceipt.simTimeUs +
    execution.stepReceipts.reduce(
      (total, receipt) => total + receipt.realizedDeltaUs,
      0,
    );
  const finalObserved = observe(
    final.content.snapshot.state,
    contract.rule.expectation.path,
  );
  return (
    execution.startCheckpointId === start.checkpointId &&
    execution.finalCheckpointId === final.checkpointId &&
    execution.restoreReceipt.nextTick === start.content.nextTick &&
    execution.restoreReceipt.simTimeUs === start.content.simTimeUs &&
    execution.restoreReceipt.stateDigest ===
      stateDigest(start.content.snapshot.state) &&
    canonicalStringify(final.content.environment as unknown as JsonValue) ===
      canonicalStringify(start.content.environment as unknown as JsonValue) &&
    final.content.nextTick === lastReceipt.realizedTick + 1 &&
    final.content.simTimeUs === expectedSimTimeUs &&
    observationsEqual(finalObserved, execution.evaluation.observed)
  );
};

export class V01GameBranchService {
  private readonly intervenedExecutions = new Set<ExecutionId>();

  public constructor(
    private readonly repository: V01ArtifactRepositoryPort,
    private readonly environments: GameEnvironmentFactoryPort,
    private readonly ids: V01IdGeneratorPort,
    private readonly clock: ClockPort,
  ) {}

  public async freezeContract(
    input: FrozenContractInput,
  ): Promise<FrozenContract> {
    const contract = deepFreeze(
      FrozenContractSchema.parse({
        ...input,
        contractId: contractIdFor(input),
      }),
    );
    await this.repository.putFrozenContract(contract);
    return contract;
  }

  public async createBaseline(
    request: CreateV01BaselineRequest,
  ): Promise<BaselineBranchSpec> {
    const contract = assertFrozenContract(
      await this.repository.getFrozenContract(request.contractId),
    );
    if (contract.contractId !== request.contractId) {
      throw new V01GameBranchError(
        "INVALID_CONTRACT",
        "Repository returned the wrong frozen Contract",
      );
    }
    CheckpointSchema.parse(
      await this.repository.getCheckpoint(request.checkpointId),
    );
    const trace = assertContentAddressedTrace(
      await this.repository.getInputTrace(request.inputTraceId),
    );
    if (trace.inputs.length !== 1 || trace.inputs[0]?.relativeTick !== 0) {
      throw new V01GameBranchError(
        "INVALID_BRANCH",
        "v0.1 baseline requires exactly one tick-0 input",
      );
    }
    if (Object.keys(request.controls.variables).length > 0) {
      throw new V01GameBranchError(
        "INVALID_BRANCH",
        "v0.1 does not claim unapplied control variables",
      );
    }
    if (request.controls.maxTicks < contract.rule.withinTicks) {
      throw new V01GameBranchError(
        "INVALID_BRANCH",
        "Baseline controls do not close the Contract observation window",
      );
    }

    const branch = BranchSpecSchema.parse({
      schemaVersion: 1,
      branchId: asBranchId(this.ids.next("branch")),
      runId: request.runId,
      branchKind: "baseline",
      contractId: request.contractId,
      startCheckpointId: request.checkpointId,
      inputTraceId: request.inputTraceId,
      controls: request.controls,
      createdAt: this.clock.nowIso(),
    });
    if (branch.branchKind !== "baseline") {
      throw new V01GameBranchError(
        "INVALID_BRANCH",
        "Expected baseline branch",
      );
    }
    await this.repository.putBranchSpec(branch);
    return branch;
  }

  public async execute(branchId: BranchId): Promise<ExecutionLog> {
    const branch = BranchSpecSchema.parse(
      await this.repository.getBranchSpec(branchId),
    );
    const contract = assertFrozenContract(
      await this.repository.getFrozenContract(branch.contractId),
    );
    const checkpoint = CheckpointSchema.parse(
      await this.repository.getCheckpoint(branch.startCheckpointId),
    );
    const trace = assertContentAddressedTrace(
      await this.repository.getInputTrace(branch.inputTraceId),
    );
    const executionId = asExecutionId(this.ids.next("execution"));
    const environment = await this.environments.create({
      environment: checkpoint.content.environment,
      runId: branch.runId,
      branchId: branch.branchId,
      executionId,
      controls: branch.controls,
      requiredCapabilities:
        checkpoint.content.environment.runtimeFingerprint?.capabilities ?? [],
      probePlan: {
        schemaVersion: 1,
        signals: [
          {
            source: contract.rule.trigger.source,
            name: contract.rule.trigger.name,
          },
        ],
        properties: [contract.rule.expectation.path],
      },
    });

    try {
      const adapterRestore = await environment.restore({
        snapshot: checkpoint.content.snapshot,
        nextTick: checkpoint.content.nextTick,
        simTimeUs: checkpoint.content.simTimeUs,
        ...(checkpoint.content.certificate === undefined
          ? {}
          : { certificate: checkpoint.content.certificate }),
      });
      if (
        !adapterRestore.restored ||
        adapterRestore.nextTick !== checkpoint.content.nextTick ||
        adapterRestore.simTimeUs !== checkpoint.content.simTimeUs ||
        stateDigest(adapterRestore.state) !==
          stateDigest(checkpoint.content.snapshot.state)
      ) {
        throw new V01GameBranchError(
          "RUNTIME_PROTOCOL_ERROR",
          "Runtime restore receipt does not match the requested checkpoint",
        );
      }
      const restoreReceipt = {
        requestedCheckpointId: checkpoint.checkpointId,
        restoredCheckpointId: checkpoint.checkpointId,
        restored: true as const,
        nextTick: adapterRestore.nextTick,
        simTimeUs: adapterRestore.simTimeUs,
        stateDigest: stateDigest(adapterRestore.state),
        ...(adapterRestore.runtimeValidation === undefined
          ? {}
          : { runtimeValidation: adapterRestore.runtimeValidation }),
      };
      const events: ExecutionTelemetryEvent[] = [];
      const stepReceipts: StepReceipt[] = [];
      const statesByTick = new Map<number, StateSnapshot>();
      const eventIdsByLocalId = new Map<string, EventId>();
      let seq = 0;
      let nextTick = checkpoint.content.nextTick;
      let nextSimTimeUs = checkpoint.content.simTimeUs;

      try {
        for (
          let relativeTick = 0;
          relativeTick <= branch.controls.maxTicks;
          relativeTick += 1
        ) {
          const scheduled = trace.inputs
            .filter((input) => input.relativeTick === relativeTick)
            .sort((left, right) => left.order - right.order);
          const runtimeInputs = scheduled.map((input) => ({
            localId: inputLocalId(nextTick, input.order),
            order: input.order,
            action: input.action,
            ...(input.target === undefined ? {} : { target: input.target }),
            payload: input.payload,
          }));
          for (const [index, input] of runtimeInputs.entries()) {
            if (eventIdsByLocalId.has(input.localId)) {
              throw new V01GameBranchError(
                "RUNTIME_PROTOCOL_ERROR",
                `Duplicate input localId ${input.localId}`,
              );
            }
            eventIdsByLocalId.set(
              input.localId,
              asEventId(`event:${executionId}:${seq + index}`),
            );
          }

          const observation = await environment.step({
            tick: nextTick,
            simTimeUs: nextSimTimeUs,
            deltaUs: branch.controls.deltaUs,
            inputs: runtimeInputs,
          });
          const receipt = observation.receipt;
          if (
            receipt.requestedTick !== nextTick ||
            receipt.requestedDeltaUs !== branch.controls.deltaUs ||
            !sameNumbers(
              receipt.appliedInputOrders,
              scheduled.map((input) => input.order),
            )
          ) {
            throw new V01GameBranchError(
              "RUNTIME_PROTOCOL_ERROR",
              "Runtime step receipt does not match the requested command",
            );
          }
          stepReceipts.push(receipt);

          for (const [index, input] of scheduled.entries()) {
            const runtimeInput = runtimeInputs[index];
            if (runtimeInput === undefined) {
              throw new V01GameBranchError(
                "RUNTIME_PROTOCOL_ERROR",
                "Applied input receipt has no matching runtime input",
              );
            }
            const eventId = eventIdsByLocalId.get(runtimeInput.localId);
            if (eventId === undefined) {
              throw new V01GameBranchError(
                "RUNTIME_PROTOCOL_ERROR",
                "Reserved input event ID is missing",
              );
            }
            events.push({
              schemaVersion: 1,
              eventId,
              executionId,
              runId: branch.runId,
              branchId: branch.branchId,
              seq,
              tick: receipt.realizedTick,
              simTimeUs: nextSimTimeUs,
              kind: "input",
              order: input.order,
              action: input.action,
              ...(input.target === undefined ? {} : { target: input.target }),
              payload: input.payload,
              requestedTick: receipt.requestedTick,
              realizedTick: receipt.realizedTick,
            });
            seq += 1;
          }

          for (const draft of observation.events) {
            if (eventIdsByLocalId.has(draft.localId)) {
              throw new V01GameBranchError(
                "RUNTIME_PROTOCOL_ERROR",
                `Duplicate environment localId ${draft.localId}`,
              );
            }
            const eventId = asEventId(`event:${executionId}:${seq}`);
            const event = materializeDraft(
              draft,
              {
                eventId,
                executionId,
                runId: branch.runId,
                branchId: branch.branchId,
                seq,
                tick: receipt.realizedTick,
                simTimeUs: nextSimTimeUs,
              },
              eventIdsByLocalId,
            );
            eventIdsByLocalId.set(draft.localId, eventId);
            events.push(event);
            seq += 1;
          }
          statesByTick.set(receipt.realizedTick, observation.state);
          nextTick = receipt.realizedTick + 1;
          nextSimTimeUs += receipt.realizedDeltaUs;
        }

        const evaluation = evaluateContract(contract, events, statesByTick);
        const finalCapture = await environment.snapshot();
        const finalCheckpoint = await this.repository.putCheckpoint({
          schemaVersion: 1,
          environment: environment.descriptor,
          nextTick,
          simTimeUs: nextSimTimeUs,
          snapshot: finalCapture.snapshot,
          ...(finalCapture.certificate === undefined
            ? {}
            : { certificate: finalCapture.certificate }),
        });
        const completed = ExecutionLogSchema.parse({
          schemaVersion: 1,
          executionId,
          runId: branch.runId,
          branchId: branch.branchId,
          contractId: branch.contractId,
          startCheckpointId: branch.startCheckpointId,
          inputTraceId: branch.inputTraceId,
          restoreReceipt,
          stepReceipts,
          events,
          timelineDigest: computeExecutionTimelineDigest(stepReceipts, events),
          sealed: true,
          ...(environment.descriptor.runtimeFingerprint === undefined
            ? {}
            : {
                runtimeFingerprint: environment.descriptor.runtimeFingerprint,
              }),
          status: "completed",
          evaluation,
          finalCheckpointId: finalCheckpoint.checkpointId,
        });
        await this.repository.putExecutionLog(completed);
        return completed;
      } catch (error) {
        const failed = ExecutionLogSchema.parse({
          schemaVersion: 1,
          executionId,
          runId: branch.runId,
          branchId: branch.branchId,
          contractId: branch.contractId,
          startCheckpointId: branch.startCheckpointId,
          inputTraceId: branch.inputTraceId,
          restoreReceipt,
          stepReceipts,
          events,
          timelineDigest: computeExecutionTimelineDigest(stepReceipts, events),
          sealed: true,
          ...(environment.descriptor.runtimeFingerprint === undefined
            ? {}
            : {
                runtimeFingerprint: environment.descriptor.runtimeFingerprint,
              }),
          status: "failed",
          failure: {
            code:
              error instanceof V01GameBranchError
                ? error.code
                : "ENVIRONMENT_FAILURE",
            message: error instanceof Error ? error.message : String(error),
          },
        });
        await this.repository.putExecutionLog(failed);
        return failed;
      }
    } finally {
      await environment.dispose();
    }
  }

  public async replayExecution(request: {
    readonly executionId: ExecutionId;
  }): Promise<ReplayExecutionResult> {
    const source = ExecutionLogSchema.parse(
      await this.repository.getExecutionLog(request.executionId),
    );
    const execution = await this.execute(source.branchId);
    return {
      execution,
      matches:
        source.status === "completed" &&
        execution.status === "completed" &&
        source.timelineDigest === execution.timelineDigest,
      sourceDigest: source.timelineDigest,
      replayDigest: execution.timelineDigest,
    };
  }

  public async runIntervention(request: {
    readonly baselineExecutionId: ExecutionId;
    readonly deltaTicks: 1;
  }): Promise<InterventionExecutionResult> {
    if (request.deltaTicks !== 1) {
      throw new V01GameBranchError(
        "INVALID_INTERVENTION",
        "v0.1 supports only a one-tick input delay",
      );
    }
    if (this.intervenedExecutions.has(request.baselineExecutionId)) {
      throw new V01GameBranchError(
        "INVALID_INTERVENTION",
        `Execution ${request.baselineExecutionId} already has its v0.1 intervention`,
      );
    }

    const baseline = ExecutionLogSchema.parse(
      await this.repository.getExecutionLog(request.baselineExecutionId),
    );
    if (baseline.status !== "completed") {
      throw new V01GameBranchError(
        "INVALID_INTERVENTION",
        "Cannot intervene on a failed execution",
      );
    }
    const parent = BranchSpecSchema.parse(
      await this.repository.getBranchSpec(baseline.branchId),
    );
    if (parent.branchKind !== "baseline") {
      throw new V01GameBranchError(
        "INVALID_INTERVENTION",
        "The v0.1 intervention must descend from a baseline BranchSpec",
      );
    }
    assertFrozenContract(
      await this.repository.getFrozenContract(parent.contractId),
    );
    const baselineTrace = assertContentAddressedTrace(
      await this.repository.getInputTrace(parent.inputTraceId),
    );
    if (baselineTrace.inputs.length !== 1) {
      throw new V01GameBranchError(
        "INVALID_INTERVENTION",
        "The v0.1 intervention requires exactly one input",
      );
    }
    const selected = baselineTrace.inputs[0];
    if (selected === undefined) {
      throw new V01GameBranchError(
        "INVALID_INTERVENTION",
        "Baseline input is missing",
      );
    }
    const delayedTick = selected.relativeTick + request.deltaTicks;
    if (delayedTick > parent.controls.maxTicks) {
      throw new V01GameBranchError(
        "INVALID_INTERVENTION",
        "Delayed input falls outside the execution window",
      );
    }
    const traceWithoutId = {
      schemaVersion: 1 as const,
      scheduleBasis: "relative_tick" as const,
      inputs: [{ ...selected, relativeTick: delayedTick }],
    };
    const candidateTrace = InputTraceSchema.parse({
      ...traceWithoutId,
      inputTraceId: asInputTraceId(
        `trace:${digestJson(traceWithoutId as unknown as JsonValue)}`,
      ),
    });
    await this.repository.putInputTrace(candidateTrace);

    const branch = BranchSpecSchema.parse({
      schemaVersion: 1,
      branchId: asBranchId(this.ids.next("branch")),
      runId: parent.runId,
      branchKind: "intervention",
      parentBranchId: parent.branchId,
      contractId: parent.contractId,
      startCheckpointId: parent.startCheckpointId,
      inputTraceId: candidateTrace.inputTraceId,
      controls: parent.controls,
      intervention: { kind: "delay_input", deltaTicks: 1 },
      createdAt: this.clock.nowIso(),
    });
    await this.repository.putBranchSpec(branch);
    this.intervenedExecutions.add(request.baselineExecutionId);
    const execution = await this.execute(branch.branchId);
    return { branch, execution };
  }

  public async compareExecutions(request: {
    readonly baselineExecutionId: ExecutionId;
    readonly candidateExecutionId: ExecutionId;
  }): Promise<ExecutionComparison> {
    const baseline = ExecutionLogSchema.parse(
      await this.repository.getExecutionLog(request.baselineExecutionId),
    );
    const candidate = ExecutionLogSchema.parse(
      await this.repository.getExecutionLog(request.candidateExecutionId),
    );
    const baselineBranch = BranchSpecSchema.parse(
      await this.repository.getBranchSpec(baseline.branchId),
    );
    const candidateBranch = BranchSpecSchema.parse(
      await this.repository.getBranchSpec(candidate.branchId),
    );
    assertFrozenContract(
      await this.repository.getFrozenContract(baseline.contractId),
    );
    const blockers: string[] = [];

    if (baseline.status !== "completed" || candidate.status !== "completed") {
      blockers.push("Both executions must complete before comparison");
    }
    if (baselineBranch.branchKind !== "baseline") {
      blockers.push(
        "The baseline execution does not use a baseline BranchSpec",
      );
    }
    if (
      candidateBranch.branchKind !== "intervention" ||
      candidateBranch.intervention.kind !== "delay_input" ||
      candidateBranch.intervention.deltaTicks !== 1
    ) {
      blockers.push("Candidate is not the supported one-tick input delay");
    } else if (candidateBranch.parentBranchId !== baselineBranch.branchId) {
      blockers.push("Candidate does not descend from the baseline BranchSpec");
    }
    if (baseline.runId !== candidate.runId) {
      blockers.push("Executions belong to different runs");
    }
    if (
      baseline.contractId !== candidate.contractId ||
      baselineBranch.contractId !== candidateBranch.contractId
    ) {
      blockers.push("Executions use different Contracts");
    }
    if (
      baseline.startCheckpointId !== candidate.startCheckpointId ||
      baselineBranch.startCheckpointId !== candidateBranch.startCheckpointId
    ) {
      blockers.push("Executions do not share the same checkpoint");
    }
    if (
      canonicalStringify(baselineBranch.controls as unknown as JsonValue) !==
      canonicalStringify(candidateBranch.controls as unknown as JsonValue)
    ) {
      blockers.push("A control other than the input trace changed");
    }

    const baselineTrace = assertContentAddressedTrace(
      await this.repository.getInputTrace(baseline.inputTraceId),
    );
    const candidateTrace = assertContentAddressedTrace(
      await this.repository.getInputTrace(candidate.inputTraceId),
    );
    if (!isOneTickInputDelay(baselineTrace, candidateTrace)) {
      blockers.push("Input traces differ by more than one one-tick delay");
    }
    if (!isRealizedOneTickInputDelay(baseline, candidate)) {
      blockers.push("The requested one-tick delay was not realized");
    }

    const comparison = ExecutionComparisonSchema.parse({
      schemaVersion: 1,
      comparisonId: asComparisonId(this.ids.next("comparison")),
      runId: baseline.runId,
      contractId: baseline.contractId,
      commonCheckpointId: baseline.startCheckpointId,
      baselineBranchId: baseline.branchId,
      candidateBranchId: candidate.branchId,
      baselineExecutionId: baseline.executionId,
      candidateExecutionId: candidate.executionId,
      intervention: { kind: "delay_input", deltaTicks: 1 },
      baselineOutcome:
        baseline.status === "completed"
          ? baseline.evaluation.status
          : "incomplete",
      candidateOutcome:
        candidate.status === "completed"
          ? candidate.evaluation.status
          : "incomplete",
      comparable: blockers.length === 0,
      blockers,
      digestsEqual: baseline.timelineDigest === candidate.timelineDigest,
      firstDivergenceTick: firstExecutionDivergenceTick(baseline, candidate),
    });
    await this.repository.putExecutionComparison(comparison);
    return comparison;
  }

  public async compileEvidence(request: {
    readonly executionId: ExecutionId;
  }): Promise<EvidenceCapsule> {
    const execution = ExecutionLogSchema.parse(
      await this.repository.getExecutionLog(request.executionId),
    );
    if (
      execution.status !== "completed" ||
      execution.evaluation.status !== "fail"
    ) {
      throw new V01GameBranchError(
        "INVALID_EXECUTION",
        "Evidence Capsule requires a completed, failing baseline execution",
      );
    }
    const branch = BranchSpecSchema.parse(
      await this.repository.getBranchSpec(execution.branchId),
    );
    if (branch.branchKind !== "baseline") {
      throw new V01GameBranchError(
        "INVALID_EXECUTION",
        "Evidence Capsule can only describe the baseline BranchSpec",
      );
    }
    const contract = assertFrozenContract(
      await this.repository.getFrozenContract(execution.contractId),
    );
    const checkpoint = CheckpointSchema.parse(
      await this.repository.getCheckpoint(execution.startCheckpointId),
    );
    const trigger = execution.events.find(
      (event) => event.eventId === execution.evaluation.triggerEventId,
    );
    if (trigger?.kind !== "signal") {
      throw new V01GameBranchError(
        "INVALID_EXECUTION",
        "Contract evaluation trigger does not resolve to a Signal",
      );
    }
    const delivery = execution.events.find(
      (event) =>
        event.kind === "signal_delivery" &&
        event.causedByEventId === trigger.eventId &&
        !event.delivered,
    );
    const receiverConnection =
      delivery?.kind !== "signal_delivery"
        ? undefined
        : execution.events.find(
            (event) =>
              event.kind === "property_changed" &&
              event.seq > delivery.seq &&
              event.path === `${delivery.receiver}.receiver_connected` &&
              jsonEqual(event.before, false) &&
              jsonEqual(event.after, true),
          );
    const eventsById = new Map(
      execution.events.map((event) => [event.eventId, event] as const),
    );
    const ancestorIds = new Set<EventId>();
    let ancestor: ExecutionTelemetryEvent | undefined = trigger;
    while (ancestor !== undefined && !ancestorIds.has(ancestor.eventId)) {
      ancestorIds.add(ancestor.eventId);
      ancestor =
        ancestor.causedByEventId === undefined
          ? undefined
          : eventsById.get(ancestor.causedByEventId);
    }
    const windowEvents = execution.events.filter(
      (event) =>
        ancestorIds.has(event.eventId) ||
        (event.seq >= trigger.seq &&
          event.tick <= execution.evaluation.deadlineTick),
    );
    const firstEvent = windowEvents[0] ?? trigger;
    const lastEvent = windowEvents.at(-1) ?? trigger;
    const expectedPath = contract.rule.expectation.path;
    const changedAtEventIds = windowEvents
      .filter(
        (event) =>
          event.kind === "property_changed" && event.path === expectedPath,
      )
      .map((event) => event.eventId);
    const before = observe(checkpoint.content.snapshot.state, expectedPath);
    const actual = execution.evaluation.observed;
    const eventLossDetected =
      !hasClosedEventLedger(execution) || runtimeObservationIsLossy(execution);
    const capsule = EvidenceCapsuleSchema.parse({
      schemaVersion: 1,
      capsuleId: asCapsuleId(this.ids.next("capsule")),
      runId: execution.runId,
      contractId: execution.contractId,
      branchId: execution.branchId,
      checkpointId: execution.startCheckpointId,
      baselineExecutionId: execution.executionId,
      observedWindow: {
        fromTick: firstEvent.tick,
        toTick: execution.evaluation.deadlineTick,
        fromSeq: firstEvent.seq,
        toSeq: lastEvent.seq,
        closed: true,
      },
      triggerEventId: trigger.eventId,
      ...(delivery === undefined
        ? {}
        : { signalDeliveryEventId: delivery.eventId }),
      ...(receiverConnection === undefined
        ? {}
        : { receiverConnectedEventId: receiverConnection.eventId }),
      eventChain: windowEvents,
      stateDiff: [
        {
          path: expectedPath,
          status: !actual.present
            ? "missing"
            : observationsEqual(before, actual)
              ? "unchanged"
              : "changed",
          before,
          after: actual,
          changedAtEventIds,
        },
      ],
      expected: contract.rule.expectation,
      actual,
      violationSummary: `Signal ${trigger.name} was emitted by ${trigger.source}, but ${expectedPath} did not become the Contract value within one tick`,
      sourceEventIds: windowEvents.map((event) => event.eventId),
      integrity: {
        executionSealed: execution.sealed,
        eventLossDetected,
        timelineDigest: execution.timelineDigest,
      },
      knownLimitations:
        execution.runtimeFingerprint === undefined
          ? ["v0.1 observes one deterministic in-process switch-door fixture"]
          : [
              "v0.2 observes one explicitly instrumented Godot switch-door fixture",
              "The checkpoint certificate does not cover Godot engine internals",
            ],
      nextMinimalExperiments: [
        "Delay the sole interaction input by exactly one tick from the same checkpoint",
      ],
    });
    await this.repository.putEvidenceCapsule(capsule);
    return capsule;
  }

  public async getEvidenceCapsule(request: {
    readonly capsuleId: CapsuleId;
  }): Promise<EvidenceCapsule> {
    const capsule = EvidenceCapsuleSchema.parse(
      await this.repository.getEvidenceCapsule(request.capsuleId),
    );
    if (capsule.capsuleId !== request.capsuleId) {
      throw new V01GameBranchError(
        "INVALID_EXECUTION",
        "Repository returned a different Evidence Capsule",
      );
    }
    return capsule;
  }

  public async conclude(request: {
    readonly proposalId: ProposalId;
  }): Promise<DiagnosisVerdict> {
    let proposal: DiagnosisProposal;
    try {
      proposal = DiagnosisProposalSchema.parse(
        await this.repository.getDiagnosisProposal(request.proposalId),
      );
      if (proposal.proposalId !== request.proposalId) {
        throw new Error("Repository returned a different DiagnosisProposal");
      }
    } catch (error) {
      throw new V01GameBranchError(
        "INVALID_PROPOSAL",
        `DiagnosisProposal ${request.proposalId} is missing or malformed`,
        { cause: error },
      );
    }

    let capsule: EvidenceCapsule;
    let baseline: ExecutionLog;
    let baselineBranch: BranchSpec;
    try {
      capsule = EvidenceCapsuleSchema.parse(
        await this.repository.getEvidenceCapsule(proposal.capsuleId),
      );
      baseline = ExecutionLogSchema.parse(
        await this.repository.getExecutionLog(proposal.baselineExecutionId),
      );
      baselineBranch = BranchSpecSchema.parse(
        await this.repository.getBranchSpec(baseline.branchId),
      );
      if (
        capsule.capsuleId !== proposal.capsuleId ||
        baseline.executionId !== proposal.baselineExecutionId ||
        baselineBranch.branchId !== baseline.branchId
      ) {
        throw new Error("Repository returned an artifact with the wrong ID");
      }
    } catch (error) {
      throw new V01GameBranchError(
        "INVALID_PROPOSAL",
        "DiagnosisProposal contains an unresolved baseline reference",
        { cause: error },
      );
    }
    if (
      proposal.runId !== capsule.runId ||
      proposal.runId !== baseline.runId ||
      capsule.baselineExecutionId !== baseline.executionId ||
      capsule.branchId !== baseline.branchId
    ) {
      throw new V01GameBranchError(
        "INVALID_PROPOSAL",
        "DiagnosisProposal baseline references do not belong to one run",
      );
    }

    const optionalExecution = async (
      executionId: ExecutionId | undefined,
      label: string,
    ): Promise<ExecutionLog | undefined> => {
      if (executionId === undefined) return undefined;
      try {
        const execution = ExecutionLogSchema.parse(
          await this.repository.getExecutionLog(executionId),
        );
        if (
          execution.executionId !== executionId ||
          execution.runId !== proposal.runId
        ) {
          throw new Error(`${label} belongs to another run`);
        }
        return execution;
      } catch (error) {
        throw new V01GameBranchError(
          "INVALID_PROPOSAL",
          `DiagnosisProposal contains an invalid ${label} reference`,
          { cause: error },
        );
      }
    };
    const replay = await optionalExecution(
      proposal.replayExecutionId,
      "replay execution",
    );
    const candidate = await optionalExecution(
      proposal.candidateExecutionId,
      "candidate execution",
    );

    let candidateBranch: BranchSpec | undefined;
    if (candidate !== undefined) {
      try {
        candidateBranch = BranchSpecSchema.parse(
          await this.repository.getBranchSpec(candidate.branchId),
        );
        if (candidateBranch.branchId !== candidate.branchId) {
          throw new Error(
            "Repository returned a different candidate BranchSpec",
          );
        }
      } catch (error) {
        throw new V01GameBranchError(
          "INVALID_PROPOSAL",
          "Candidate execution has an unresolved BranchSpec",
          { cause: error },
        );
      }
    }

    let comparison: ExecutionComparison | undefined;
    if (proposal.comparisonId !== undefined) {
      try {
        comparison = ExecutionComparisonSchema.parse(
          await this.repository.getExecutionComparison(proposal.comparisonId),
        );
        if (
          comparison.comparisonId !== proposal.comparisonId ||
          comparison.runId !== proposal.runId
        ) {
          throw new Error("Comparison belongs to another run");
        }
      } catch (error) {
        throw new V01GameBranchError(
          "INVALID_PROPOSAL",
          "DiagnosisProposal contains an invalid comparison reference",
          { cause: error },
        );
      }
    }

    const blockers: ConclusionBlocker[] = [];
    const addBlocker = (
      code: ConclusionBlocker["code"],
      message: string,
      references: readonly ArtifactReference[],
    ): void => {
      if (!blockers.some((blocker) => blocker.code === code)) {
        blockers.push({ code, message, references });
      }
    };
    const baselineRef: ArtifactReference = {
      artifactKind: "execution",
      executionId: baseline.executionId,
    };
    const capsuleRef: ArtifactReference = {
      artifactKind: "capsule",
      capsuleId: capsule.capsuleId,
    };

    let contract: FrozenContract | undefined;
    try {
      contract = assertFrozenContract(
        await this.repository.getFrozenContract(baseline.contractId),
      );
    } catch {
      addBlocker(
        "CONTRACT_NOT_FROZEN",
        "The frozen Contract is missing or its content hash is invalid",
        [baselineRef, capsuleRef],
      );
    }
    if (
      contract !== undefined &&
      (capsule.contractId !== contract.contractId ||
        baselineBranch.contractId !== contract.contractId)
    ) {
      addBlocker(
        "CONTRACT_MISMATCH",
        "Baseline, capsule, and BranchSpec do not reference one Contract",
        [baselineRef, capsuleRef],
      );
    }

    const loadCheckpoint = async (
      checkpointId: CheckpointId,
    ): Promise<Checkpoint | undefined> => {
      try {
        const checkpoint = CheckpointSchema.parse(
          await this.repository.getCheckpoint(checkpointId),
        );
        return checkpoint.checkpointId === checkpointId
          ? checkpoint
          : undefined;
      } catch {
        return undefined;
      }
    };
    const startCheckpoint = await loadCheckpoint(baseline.startCheckpointId);
    const baselineFinalCheckpoint =
      baseline.status === "completed"
        ? await loadCheckpoint(baseline.finalCheckpointId)
        : undefined;
    const replayFinalCheckpoint =
      replay?.status === "completed"
        ? await loadCheckpoint(replay.finalCheckpointId)
        : undefined;
    const candidateFinalCheckpoint =
      candidate?.status === "completed"
        ? await loadCheckpoint(candidate.finalCheckpointId)
        : undefined;
    if (
      startCheckpoint === undefined ||
      baselineFinalCheckpoint === undefined ||
      capsule.checkpointId !== baseline.startCheckpointId ||
      baselineBranch.startCheckpointId !== baseline.startCheckpointId
    ) {
      addBlocker(
        "CHECKPOINT_MISMATCH",
        "Baseline start/final checkpoint lineage cannot be resolved",
        [baselineRef],
      );
    }
    if (
      startCheckpoint !== undefined &&
      baseline.runtimeFingerprint !== undefined &&
      !checkpointIsAdmissibleForGodot(startCheckpoint, baseline)
    ) {
      addBlocker(
        "CHECKPOINT_MISMATCH",
        "Godot checkpoint certificate, runtime fingerprint, or required fixture coverage is insufficient",
        [baselineRef],
      );
    }

    const baselineCanonicalEvaluation =
      contract === undefined || startCheckpoint === undefined
        ? undefined
        : recomputeContractEvaluation(
            contract,
            startCheckpoint.content.snapshot.state,
            baseline,
          );

    if (
      baselineBranch.branchKind !== "baseline" ||
      baselineBranch.runId !== baseline.runId ||
      baselineBranch.contractId !== baseline.contractId ||
      baselineBranch.startCheckpointId !== baseline.startCheckpointId ||
      baselineBranch.inputTraceId !== baseline.inputTraceId ||
      baseline.status !== "completed" ||
      !executionIsAdmissible(baseline)
    ) {
      addBlocker(
        "EXECUTION_NOT_ADMISSIBLE",
        "Baseline execution is not sealed, internally consistent, and complete",
        [baselineRef],
      );
    } else if (
      baseline.evaluation.status !== "fail" ||
      baselineCanonicalEvaluation === undefined ||
      baselineCanonicalEvaluation.status !== "fail" ||
      !evaluationsEqual(baseline.evaluation, baselineCanonicalEvaluation)
    ) {
      addBlocker(
        "BASELINE_NOT_FAILED",
        "Baseline evaluation does not canonically reproduce a Contract failure",
        [baselineRef],
      );
    }
    if (
      contract !== undefined &&
      startCheckpoint !== undefined &&
      baselineFinalCheckpoint !== undefined &&
      !checkpointMatchesExecution(
        startCheckpoint,
        baselineFinalCheckpoint,
        baseline,
        contract,
      )
    ) {
      addBlocker(
        "CHECKPOINT_MISMATCH",
        "Baseline final checkpoint does not match its realized execution",
        [baselineRef],
      );
    }

    const capsuleFacts = validateCapsuleFacts(capsule, baseline, contract);
    for (const issue of capsuleFacts) {
      addBlocker(issue.code, issue.message, [capsuleRef, baselineRef]);
    }

    if (replay === undefined) {
      addBlocker(
        "EXECUTION_NOT_ADMISSIBLE",
        "No strict baseline replay was supplied",
        [baselineRef],
      );
    } else {
      const replayRef: ArtifactReference = {
        artifactKind: "execution",
        executionId: replay.executionId,
      };
      const replayCanonicalEvaluation =
        contract === undefined || startCheckpoint === undefined
          ? undefined
          : recomputeContractEvaluation(
              contract,
              startCheckpoint.content.snapshot.state,
              replay,
            );
      if (
        replay.executionId === baseline.executionId ||
        baseline.status !== "completed" ||
        replay.status !== "completed" ||
        !executionIsAdmissible(replay) ||
        replay.branchId !== baseline.branchId ||
        replay.contractId !== baseline.contractId ||
        replay.startCheckpointId !== baseline.startCheckpointId ||
        replay.inputTraceId !== baseline.inputTraceId ||
        replay.timelineDigest !== baseline.timelineDigest ||
        replay.evaluation.status !== "fail" ||
        replayCanonicalEvaluation === undefined ||
        replayCanonicalEvaluation.status !== "fail" ||
        !evaluationsEqual(replay.evaluation, replayCanonicalEvaluation) ||
        baselineCanonicalEvaluation === undefined ||
        !evaluationSemanticsEqual(
          baselineCanonicalEvaluation,
          replayCanonicalEvaluation,
        ) ||
        replayFinalCheckpoint === undefined ||
        baselineFinalCheckpoint === undefined ||
        replay.finalCheckpointId !== baseline.finalCheckpointId ||
        canonicalStringify(
          replayFinalCheckpoint.content as unknown as JsonValue,
        ) !==
          canonicalStringify(
            baselineFinalCheckpoint.content as unknown as JsonValue,
          ) ||
        (contract !== undefined &&
          startCheckpoint !== undefined &&
          !checkpointMatchesExecution(
            startCheckpoint,
            replayFinalCheckpoint,
            replay,
            contract,
          ))
      ) {
        addBlocker(
          "REPLAY_DIVERGED",
          "Baseline replay does not reproduce the sealed baseline timeline",
          [baselineRef, replayRef],
        );
      }
    }

    if (candidate === undefined || candidateBranch === undefined) {
      addBlocker(
        "CANDIDATE_NOT_PASSED",
        "No candidate intervention execution was supplied",
        [baselineRef],
      );
    } else {
      const candidateRef: ArtifactReference = {
        artifactKind: "execution",
        executionId: candidate.executionId,
      };
      const candidateCanonicalEvaluation =
        contract === undefined || startCheckpoint === undefined
          ? undefined
          : recomputeContractEvaluation(
              contract,
              startCheckpoint.content.snapshot.state,
              candidate,
            );
      if (
        candidate.executionId === baseline.executionId ||
        candidate.executionId === replay?.executionId ||
        candidate.status !== "completed" ||
        !executionIsAdmissible(candidate) ||
        candidate.evaluation.status !== "pass" ||
        candidateCanonicalEvaluation === undefined ||
        candidateCanonicalEvaluation.status !== "pass" ||
        !evaluationsEqual(candidate.evaluation, candidateCanonicalEvaluation) ||
        candidateFinalCheckpoint === undefined ||
        (contract !== undefined &&
          startCheckpoint !== undefined &&
          !checkpointMatchesExecution(
            startCheckpoint,
            candidateFinalCheckpoint,
            candidate,
            contract,
          ))
      ) {
        addBlocker(
          "CANDIDATE_NOT_PASSED",
          "Candidate execution did not pass the frozen Contract",
          [candidateRef],
        );
      }
      if (
        candidateBranch.branchKind !== "intervention" ||
        candidateBranch.branchId === baselineBranch.branchId ||
        candidateBranch.runId !== candidate.runId ||
        candidate.runId !== baseline.runId ||
        candidateBranch.contractId !== candidate.contractId ||
        candidateBranch.startCheckpointId !== candidate.startCheckpointId ||
        candidateBranch.inputTraceId !== candidate.inputTraceId ||
        candidateBranch.parentBranchId !== baseline.branchId ||
        candidateBranch.intervention.kind !== "delay_input" ||
        candidateBranch.intervention.deltaTicks !== 1 ||
        candidate.startCheckpointId !== baseline.startCheckpointId ||
        candidate.contractId !== baseline.contractId ||
        canonicalStringify(candidateBranch.controls as unknown as JsonValue) !==
          canonicalStringify(baselineBranch.controls as unknown as JsonValue)
      ) {
        addBlocker(
          "INTERVENTION_NOT_ISOLATED",
          "Candidate is not an isolated one-tick input intervention",
          [baselineRef, candidateRef],
        );
      }
      if (!isRealizedOneTickInputDelay(baseline, candidate)) {
        addBlocker(
          "INTERVENTION_NOT_REALIZED",
          "Runtime receipts do not show the requested one-tick delay",
          [baselineRef, candidateRef],
        );
      }
      try {
        const baselineTrace = assertContentAddressedTrace(
          await this.repository.getInputTrace(baseline.inputTraceId),
        );
        const candidateTrace = assertContentAddressedTrace(
          await this.repository.getInputTrace(candidate.inputTraceId),
        );
        if (!isOneTickInputDelay(baselineTrace, candidateTrace)) {
          addBlocker(
            "INTERVENTION_NOT_ISOLATED",
            "Persisted traces differ by more than the one supported input delay",
            [baselineRef, candidateRef],
          );
        }
      } catch {
        addBlocker(
          "INTERVENTION_NOT_ISOLATED",
          "Intervention input traces are missing or fail content-hash validation",
          [baselineRef, candidateRef],
        );
      }
      if (!candidateSupportsMechanism(candidate, contract)) {
        addBlocker(
          "STATE_EVIDENCE_MISSING",
          "Candidate lacks receiver-before-signal, delivered Signal, and door-open evidence",
          [candidateRef],
        );
      }
    }

    if (
      comparison === undefined ||
      replay === undefined ||
      candidate === undefined ||
      candidateBranch === undefined
    ) {
      addBlocker(
        "COMPARISON_NOT_ADMISSIBLE",
        "No complete execution comparison was supplied",
        [baselineRef],
      );
    } else {
      const comparisonRef: ArtifactReference = {
        artifactKind: "comparison",
        comparisonId: comparison.comparisonId,
      };
      if (
        !comparison.comparable ||
        comparison.blockers.length > 0 ||
        comparison.baselineExecutionId !== replay.executionId ||
        comparison.candidateExecutionId !== candidate.executionId ||
        comparison.baselineBranchId !== replay.branchId ||
        comparison.candidateBranchId !== candidate.branchId ||
        comparison.contractId !== baseline.contractId ||
        comparison.commonCheckpointId !== baseline.startCheckpointId ||
        comparison.baselineOutcome !==
          (replay.status === "completed"
            ? replay.evaluation.status
            : "incomplete") ||
        comparison.baselineOutcome !== "fail" ||
        comparison.candidateOutcome !==
          (candidate.status === "completed"
            ? candidate.evaluation.status
            : "incomplete") ||
        comparison.digestsEqual !==
          (replay.timelineDigest === candidate.timelineDigest) ||
        comparison.firstDivergenceTick !==
          firstExecutionDivergenceTick(replay, candidate)
      ) {
        addBlocker(
          "COMPARISON_NOT_ADMISSIBLE",
          "Stored comparison does not match the referenced execution facts",
          [comparisonRef, baselineRef],
        );
      }
    }

    if (
      !proposalSupportsCanonicalMechanism(
        proposal,
        capsule,
        baseline,
        comparison,
        contract,
      )
    ) {
      addBlocker(
        "CLAIM_NOT_SUPPORTED",
        "Agent claim does not exactly match the canonical signal-ordering mechanism facts",
        [capsuleRef],
      );
    }

    const validatedReferences = await this.validateProposalReferences({
      proposal,
      capsule,
      baseline,
      baselineBranch,
      replay,
      candidate,
      candidateBranch,
      comparison,
      contract,
    });
    const canonicalReferences = completeVerdictReferences({
      capsule,
      baseline,
      baselineBranch,
      replay,
      candidate,
      candidateBranch,
      comparison,
      contract,
    });
    const canonicalResolution =
      await this.resolveCanonicalReferences(canonicalReferences);
    if (canonicalResolution.unresolved.length > 0) {
      addBlocker(
        canonicalResolution.unresolved.some(
          (reference) => reference.artifactKind === "checkpoint",
        )
          ? "CHECKPOINT_MISMATCH"
          : "EXECUTION_NOT_ADMISSIBLE",
        "One or more canonical verdict references cannot be resolved with the requested ID",
        [baselineRef, capsuleRef],
      );
    }
    const allValidated = deduplicateReferences([
      ...validatedReferences,
      ...canonicalResolution.resolved,
    ]);
    const verdictId = asVerdictId(this.ids.next("verdict"));
    const verdict = DiagnosisVerdictSchema.parse(
      blockers.length === 0
        ? {
            schemaVersion: 1,
            verdictId,
            proposalId: proposal.proposalId,
            runId: proposal.runId,
            status: "confirmed",
            claimLevel: "mechanism_supported",
            mechanismCode: "signal_before_receiver_connection",
            summary:
              "The switch Signal was emitted before the door receiver connected; delaying the same input by one tick delivered the Signal and opened the door.",
            validatedReferences: allValidated,
            blockers: [],
            nextExperiment: null,
          }
        : {
            schemaVersion: 1,
            verdictId,
            proposalId: proposal.proposalId,
            runId: proposal.runId,
            status: "inconclusive",
            claimLevel: "none",
            summary:
              "The available artifacts do not meet the v0.1 mechanism evidence gate.",
            validatedReferences: allValidated,
            blockers,
            nextExperiment:
              proposal.nextExperiment ??
              capsule.nextMinimalExperiments[0] ??
              "Replay from the same checkpoint and run one isolated input-delay experiment.",
          },
    );
    await this.repository.putDiagnosisVerdict(verdict);
    return verdict;
  }

  private async validateProposalReferences(context: {
    readonly proposal: DiagnosisProposal;
    readonly capsule: EvidenceCapsule;
    readonly baseline: ExecutionLog;
    readonly baselineBranch: BranchSpec;
    readonly replay: ExecutionLog | undefined;
    readonly candidate: ExecutionLog | undefined;
    readonly candidateBranch: BranchSpec | undefined;
    readonly comparison: ExecutionComparison | undefined;
    readonly contract: FrozenContract | undefined;
  }): Promise<readonly ArtifactReference[]> {
    const allowed = new Map<string, ArtifactReference>();
    const add = (reference: ArtifactReference): void => {
      allowed.set(referenceKey(reference), reference);
    };
    for (const reference of completeVerdictReferences(context)) add(reference);

    const requested = context.proposal.observedFacts.flatMap(
      (fact) => fact.references,
    );
    for (const reference of requested) {
      if (!allowed.has(referenceKey(reference))) {
        throw new V01GameBranchError(
          "INVALID_PROPOSAL",
          `Observed fact references an unresolved or cross-run artifact: ${referenceKey(reference)}`,
        );
      }
      if (!(await this.repositoryReferenceMatches(reference))) {
        throw new V01GameBranchError(
          "INVALID_PROPOSAL",
          `Observed fact reference cannot be resolved: ${referenceKey(reference)}`,
        );
      }
    }
    return deduplicateReferences(requested);
  }

  private async resolveCanonicalReferences(
    references: readonly ArtifactReference[],
  ): Promise<{
    readonly resolved: readonly ArtifactReference[];
    readonly unresolved: readonly ArtifactReference[];
  }> {
    const resolved: ArtifactReference[] = [];
    const unresolved: ArtifactReference[] = [];
    for (const reference of references) {
      if (await this.repositoryReferenceMatches(reference)) {
        resolved.push(reference);
      } else {
        unresolved.push(reference);
      }
    }
    return { resolved, unresolved };
  }

  private async repositoryReferenceMatches(
    reference: ArtifactReference,
  ): Promise<boolean> {
    try {
      switch (reference.artifactKind) {
        case "contract": {
          const artifact = FrozenContractSchema.parse(
            await this.repository.getFrozenContract(reference.contractId),
          );
          return artifact.contractId === reference.contractId;
        }
        case "branch": {
          const artifact = BranchSpecSchema.parse(
            await this.repository.getBranchSpec(reference.branchId),
          );
          return artifact.branchId === reference.branchId;
        }
        case "checkpoint": {
          const artifact = CheckpointSchema.parse(
            await this.repository.getCheckpoint(reference.checkpointId),
          );
          return artifact.checkpointId === reference.checkpointId;
        }
        case "execution": {
          const artifact = ExecutionLogSchema.parse(
            await this.repository.getExecutionLog(reference.executionId),
          );
          return artifact.executionId === reference.executionId;
        }
        case "capsule": {
          const artifact = EvidenceCapsuleSchema.parse(
            await this.repository.getEvidenceCapsule(reference.capsuleId),
          );
          return artifact.capsuleId === reference.capsuleId;
        }
        case "comparison": {
          const artifact = ExecutionComparisonSchema.parse(
            await this.repository.getExecutionComparison(
              reference.comparisonId,
            ),
          );
          return artifact.comparisonId === reference.comparisonId;
        }
        case "event":
          return true;
      }
    } catch {
      return false;
    }
  }
}

const observationsEqual = (
  left: { readonly present: boolean; readonly value?: JsonValue | undefined },
  right: { readonly present: boolean; readonly value?: JsonValue | undefined },
): boolean =>
  left.present === right.present &&
  (!left.present || jsonEqual(left.value ?? null, right.value ?? null));

const isOneTickInputDelay = (
  baseline: InputTrace,
  candidate: InputTrace,
): boolean => {
  if (baseline.inputs.length !== 1 || candidate.inputs.length !== 1) {
    return false;
  }
  const before = baseline.inputs[0];
  const after = candidate.inputs[0];
  if (before === undefined || after === undefined) return false;
  return (
    after.relativeTick === before.relativeTick + 1 &&
    after.order === before.order &&
    after.action === before.action &&
    after.target === before.target &&
    canonicalStringify(after.payload) === canonicalStringify(before.payload)
  );
};

const isRealizedOneTickInputDelay = (
  baseline: ExecutionLog,
  candidate: ExecutionLog,
): boolean => {
  const before = baseline.events.filter((event) => event.kind === "input");
  const after = candidate.events.filter((event) => event.kind === "input");
  if (before.length !== 1 || after.length !== 1) return false;
  const baselineInput = before[0];
  const candidateInput = after[0];
  if (baselineInput?.kind !== "input" || candidateInput?.kind !== "input") {
    return false;
  }
  return (
    candidateInput.requestedTick === baselineInput.requestedTick + 1 &&
    candidateInput.realizedTick === baselineInput.realizedTick + 1 &&
    baselineInput.requestedTick === baselineInput.realizedTick &&
    candidateInput.requestedTick === candidateInput.realizedTick &&
    candidateInput.order === baselineInput.order &&
    candidateInput.action === baselineInput.action &&
    candidateInput.target === baselineInput.target &&
    canonicalStringify(candidateInput.payload) ===
      canonicalStringify(baselineInput.payload)
  );
};

const hasClosedEventLedger = (execution: ExecutionLog): boolean => {
  const seen = new Set<EventId>();
  for (const [index, event] of execution.events.entries()) {
    if (
      event.seq !== index ||
      event.executionId !== execution.executionId ||
      event.runId !== execution.runId ||
      event.branchId !== execution.branchId ||
      seen.has(event.eventId) ||
      (event.causedByEventId !== undefined && !seen.has(event.causedByEventId))
    ) {
      return false;
    }
    seen.add(event.eventId);
  }
  return true;
};

const runtimeObservationIsLossy = (execution: ExecutionLog): boolean =>
  execution.stepReceipts.some((receipt) => {
    const health = receipt.runtime?.observationHealth;
    return (
      health !== undefined &&
      (health.droppedEvents > 0 ||
        health.truncatedEvents > 0 ||
        health.backpressure)
    );
  });

const runtimeEvidenceIsAdmissible = (execution: ExecutionLog): boolean => {
  if (execution.runtimeFingerprint === undefined) return true;
  if (
    execution.restoreReceipt.runtimeValidation === undefined ||
    execution.restoreReceipt.runtimeValidation.validations.some(
      (validation) => validation.status !== "pass",
    )
  ) {
    return false;
  }
  return execution.stepReceipts.every((receipt) => {
    const runtime = receipt.runtime;
    if (runtime === undefined) return false;
    const realizedIdleUs = runtime.actualIdleDeltasUs.reduce(
      (total, delta) => total + delta,
      0,
    );
    return (
      !runtimeObservationIsLossy({
        ...execution,
        stepReceipts: [receipt],
      }) &&
      realizedIdleUs === receipt.realizedDeltaUs &&
      runtime.inputApplications.length === receipt.appliedInputOrders.length &&
      runtime.inputApplications.every(
        (application, index) =>
          application.order === receipt.appliedInputOrders[index],
      )
    );
  });
};

const REQUIRED_GODOT_CHECKPOINT_DOMAINS = [
  "fixture.switch_state",
  "fixture.door_state",
  "fixture.signal_connections",
  "logical_clock",
  "input_schedule",
] as const;

const checkpointIsAdmissibleForGodot = (
  checkpoint: Checkpoint,
  execution: ExecutionLog,
): boolean => {
  const certificate = checkpoint.content.certificate;
  const fingerprint = execution.runtimeFingerprint;
  if (certificate === undefined || fingerprint === undefined) return false;
  if (
    canonicalStringify(
      certificate.environmentFingerprint as unknown as JsonValue,
    ) !== canonicalStringify(fingerprint as unknown as JsonValue) ||
    canonicalStringify(
      checkpoint.content.environment.runtimeFingerprint as unknown as JsonValue,
    ) !== canonicalStringify(fingerprint as unknown as JsonValue) ||
    certificate.restoreRecipeHash !==
      digestJson(checkpoint.content.snapshot as unknown as JsonValue).slice(
        "sha256:".length,
      ) ||
    certificate.restoreValidation.some(
      (validation) => validation.status !== "pass",
    )
  ) {
    return false;
  }
  const covered = new Set(certificate.coveredStateDomains);
  return REQUIRED_GODOT_CHECKPOINT_DOMAINS.every((domain) =>
    covered.has(domain),
  );
};

const executionIsAdmissible = (execution: ExecutionLog): boolean =>
  execution.sealed &&
  hasClosedEventLedger(execution) &&
  runtimeEvidenceIsAdmissible(execution) &&
  execution.timelineDigest ===
    computeExecutionTimelineDigest(execution.stepReceipts, execution.events);

const validateCapsuleFacts = (
  capsule: EvidenceCapsule,
  baseline: ExecutionLog,
  contract: FrozenContract | undefined,
): readonly Pick<ConclusionBlocker, "code" | "message">[] => {
  const issues: Pick<ConclusionBlocker, "code" | "message">[] = [];
  const add = (code: ConclusionBlocker["code"], message: string): void => {
    if (!issues.some((issue) => issue.code === code)) {
      issues.push({ code, message });
    }
  };
  if (
    capsule.baselineExecutionId !== baseline.executionId ||
    capsule.runId !== baseline.runId ||
    capsule.branchId !== baseline.branchId ||
    capsule.checkpointId !== baseline.startCheckpointId ||
    capsule.contractId !== baseline.contractId ||
    !capsule.integrity.executionSealed ||
    capsule.integrity.eventLossDetected ||
    capsule.integrity.timelineDigest !== baseline.timelineDigest ||
    !executionIsAdmissible(baseline)
  ) {
    add(
      "EVENT_LOSS_DETECTED",
      "Capsule lineage or execution integrity does not match the sealed baseline",
    );
  }

  const chainIds = new Set<EventId>();
  let lastSeq = -1;
  for (const event of capsule.eventChain) {
    const source = baseline.events.find(
      (candidate) => candidate.eventId === event.eventId,
    );
    if (
      source === undefined ||
      canonicalStringify(source as unknown as JsonValue) !==
        canonicalStringify(event as unknown as JsonValue) ||
      chainIds.has(event.eventId) ||
      event.seq <= lastSeq ||
      (event.causedByEventId !== undefined &&
        !chainIds.has(event.causedByEventId))
    ) {
      add(
        "EVENT_LOSS_DETECTED",
        "Capsule event chain is not unique, ordered, causally closed, and baseline-backed",
      );
      break;
    }
    chainIds.add(event.eventId);
    lastSeq = event.seq;
  }
  if (
    capsule.sourceEventIds.length !== capsule.eventChain.length ||
    capsule.sourceEventIds.some(
      (eventId, index) => capsule.eventChain[index]?.eventId !== eventId,
    )
  ) {
    add(
      "EVENT_LOSS_DETECTED",
      "Capsule sourceEventIds do not exactly cover its event chain",
    );
  }

  const trigger = capsule.eventChain.find(
    (event) => event.eventId === capsule.triggerEventId,
  );
  if (
    trigger?.kind !== "signal" ||
    baseline.status !== "completed" ||
    baseline.evaluation.triggerEventId !== capsule.triggerEventId ||
    (contract !== undefined &&
      (trigger.source !== contract.rule.trigger.source ||
        trigger.name !== contract.rule.trigger.name))
  ) {
    add(
      "SIGNAL_EVIDENCE_MISSING",
      "Capsule trigger is not the Contract Signal",
    );
  }

  const delivery = capsule.eventChain.find(
    (event) => event.eventId === capsule.signalDeliveryEventId,
  );
  if (
    trigger?.kind !== "signal" ||
    delivery?.kind !== "signal_delivery" ||
    delivery.causedByEventId !== trigger.eventId ||
    delivery.source !== trigger.source ||
    delivery.name !== trigger.name ||
    delivery.delivered ||
    delivery.failureReason !== "receiver_not_connected"
  ) {
    add(
      "DELIVERY_EVIDENCE_MISSING",
      "Capsule lacks a failed receiver_not_connected delivery caused by its Signal",
    );
  }

  const receiverConnection = capsule.eventChain.find(
    (event) => event.eventId === capsule.receiverConnectedEventId,
  );
  if (
    delivery?.kind !== "signal_delivery" ||
    receiverConnection?.kind !== "property_changed" ||
    receiverConnection.path !== `${delivery.receiver}.receiver_connected` ||
    !jsonEqual(receiverConnection.before, false) ||
    !jsonEqual(receiverConnection.after, true) ||
    receiverConnection.seq <= delivery.seq ||
    receiverConnection.tick > capsule.observedWindow.toTick
  ) {
    add(
      "DELIVERY_EVIDENCE_MISSING",
      "Capsule does not show the receiver connecting after the failed delivery",
    );
  }

  const expectedPath = contract?.rule.expectation.path;
  const diff = capsule.stateDiff.find(
    (entry) => expectedPath === undefined || entry.path === expectedPath,
  );
  if (
    diff === undefined ||
    diff.changedAtEventIds.some((eventId) => !chainIds.has(eventId)) ||
    (baseline.status === "completed" &&
      !observationsEqual(diff.after, baseline.evaluation.observed)) ||
    !observationsEqual(capsule.actual, diff.after) ||
    (contract !== undefined &&
      (!jsonEqual(capsule.expected.value, contract.rule.expectation.value) ||
        capsule.expected.path !== contract.rule.expectation.path))
  ) {
    add(
      "STATE_EVIDENCE_MISSING",
      "Capsule state diff does not resolve to the baseline Contract evaluation",
    );
  }
  return issues;
};

const candidateSupportsMechanism = (
  candidate: ExecutionLog,
  contract: FrozenContract | undefined,
): boolean => {
  if (candidate.status !== "completed" || contract === undefined) return false;
  const signal = candidate.events.find(
    (event) =>
      event.kind === "signal" &&
      event.source === contract.rule.trigger.source &&
      event.name === contract.rule.trigger.name,
  );
  if (signal?.kind !== "signal") return false;
  const delivery = candidate.events.find(
    (event) =>
      event.kind === "signal_delivery" &&
      event.causedByEventId === signal.eventId &&
      event.delivered &&
      event.failureReason === undefined,
  );
  if (delivery?.kind !== "signal_delivery") return false;
  const connection = candidate.events.find(
    (event) =>
      event.kind === "property_changed" &&
      event.path === `${delivery.receiver}.receiver_connected` &&
      jsonEqual(event.before, false) &&
      jsonEqual(event.after, true) &&
      event.seq < signal.seq,
  );
  const doorOpened = candidate.events.find(
    (event) =>
      event.kind === "property_changed" &&
      event.path === contract.rule.expectation.path &&
      jsonEqual(event.after, contract.rule.expectation.value) &&
      event.causedByEventId === delivery.eventId,
  );
  return connection !== undefined && doorOpened !== undefined;
};

const proposalSupportsCanonicalMechanism = (
  proposal: DiagnosisProposal,
  capsule: EvidenceCapsule,
  baseline: ExecutionLog,
  comparison: ExecutionComparison | undefined,
  contract: FrozenContract | undefined,
): boolean => {
  if (
    proposal.claim.kind !== "mechanism" ||
    proposal.claim.category !== "signal_ordering" ||
    proposal.claim.mechanismCode !== "signal_before_receiver_connection" ||
    proposal.observedFacts.length === 0 ||
    comparison === undefined ||
    contract === undefined
  ) {
    return false;
  }
  const delivery = baseline.events.find(
    (event) => event.eventId === capsule.signalDeliveryEventId,
  );
  if (
    delivery?.kind !== "signal_delivery" ||
    delivery.delivered ||
    delivery.failureReason !== "receiver_not_connected"
  ) {
    return false;
  }
  const assertion = proposal.claim.assertion;
  return (
    assertion.signal.kind === contract.rule.trigger.kind &&
    assertion.signal.source === contract.rule.trigger.source &&
    assertion.signal.name === contract.rule.trigger.name &&
    assertion.receiver === delivery.receiver &&
    assertion.failedDeliveryReason === delivery.failureReason &&
    assertion.expectedEffect.kind === contract.rule.expectation.kind &&
    assertion.expectedEffect.path === contract.rule.expectation.path &&
    jsonEqual(
      assertion.expectedEffect.value,
      contract.rule.expectation.value,
    ) &&
    assertion.intervention.kind === comparison.intervention.kind &&
    assertion.intervention.deltaTicks === comparison.intervention.deltaTicks
  );
};

const referenceKey = (reference: ArtifactReference): string => {
  switch (reference.artifactKind) {
    case "contract":
      return `contract:${reference.contractId}`;
    case "branch":
      return `branch:${reference.branchId}`;
    case "checkpoint":
      return `checkpoint:${reference.checkpointId}`;
    case "execution":
      return `execution:${reference.executionId}`;
    case "capsule":
      return `capsule:${reference.capsuleId}`;
    case "comparison":
      return `comparison:${reference.comparisonId}`;
    case "event":
      return `event:${reference.eventId}`;
  }
};

const deduplicateReferences = (
  references: readonly ArtifactReference[],
): readonly ArtifactReference[] => [
  ...new Map(
    references.map(
      (reference) => [referenceKey(reference), reference] as const,
    ),
  ).values(),
];

const completeVerdictReferences = (context: {
  readonly capsule: EvidenceCapsule;
  readonly baseline: ExecutionLog;
  readonly baselineBranch: BranchSpec;
  readonly replay: ExecutionLog | undefined;
  readonly candidate: ExecutionLog | undefined;
  readonly candidateBranch: BranchSpec | undefined;
  readonly comparison: ExecutionComparison | undefined;
  readonly contract: FrozenContract | undefined;
}): readonly ArtifactReference[] => {
  const references: ArtifactReference[] = [
    { artifactKind: "capsule", capsuleId: context.capsule.capsuleId },
    {
      artifactKind: "execution",
      executionId: context.baseline.executionId,
    },
    { artifactKind: "branch", branchId: context.baselineBranch.branchId },
    {
      artifactKind: "checkpoint",
      checkpointId: context.baseline.startCheckpointId,
    },
    { artifactKind: "event", eventId: context.capsule.triggerEventId },
  ];
  if (context.contract !== undefined) {
    references.push({
      artifactKind: "contract",
      contractId: context.contract.contractId,
    });
  }
  if (context.capsule.signalDeliveryEventId !== undefined) {
    references.push({
      artifactKind: "event",
      eventId: context.capsule.signalDeliveryEventId,
    });
  }
  if (context.capsule.receiverConnectedEventId !== undefined) {
    references.push({
      artifactKind: "event",
      eventId: context.capsule.receiverConnectedEventId,
    });
  }
  if (context.baseline.status === "completed") {
    references.push({
      artifactKind: "checkpoint",
      checkpointId: context.baseline.finalCheckpointId,
    });
  }
  for (const event of context.baseline.events) {
    references.push({ artifactKind: "event", eventId: event.eventId });
  }
  if (context.replay !== undefined) {
    references.push({
      artifactKind: "execution",
      executionId: context.replay.executionId,
    });
    if (context.replay.status === "completed") {
      references.push({
        artifactKind: "checkpoint",
        checkpointId: context.replay.finalCheckpointId,
      });
    }
    for (const event of context.replay.events) {
      references.push({ artifactKind: "event", eventId: event.eventId });
    }
  }
  if (context.candidate !== undefined) {
    references.push({
      artifactKind: "execution",
      executionId: context.candidate.executionId,
    });
    if (context.candidate.status === "completed") {
      references.push({
        artifactKind: "checkpoint",
        checkpointId: context.candidate.finalCheckpointId,
      });
    }
    for (const event of context.candidate.events) {
      references.push({ artifactKind: "event", eventId: event.eventId });
    }
  }
  if (context.candidateBranch !== undefined) {
    references.push({
      artifactKind: "branch",
      branchId: context.candidateBranch.branchId,
    });
  }
  if (context.comparison !== undefined) {
    references.push({
      artifactKind: "comparison",
      comparisonId: context.comparison.comparisonId,
    });
  }
  return deduplicateReferences(references);
};
