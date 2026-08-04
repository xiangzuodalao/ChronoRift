import { createHash } from "node:crypto";

import {
  CheckpointSchema,
  DiagnosisProposalV2Schema,
  DiagnosisVerdictV2Schema,
  EvidenceCapsuleV2Schema,
  ExperimentCandidateV1Schema,
  FrozenContractV2Schema,
  InputTraceV2Schema,
  V03BranchSpecSchema,
  V03ExecutionComparisonSchema,
  V03ExecutionLogSchema,
  asBranchId,
  asCapsuleId,
  asComparisonId,
  asContractId,
  asEventId,
  asExecutionId,
  asInputTraceId,
  asVerdictId,
  type BranchControls,
  type Checkpoint,
  type ContractEvaluationV2,
  type DiagnosisProposalV2,
  type DiagnosisVerdictV2,
  type EntityRefV1,
  type EvidenceCapsuleV2,
  type EvidenceLinkV2,
  type ExecutionId,
  type ExperimentCandidateV1,
  type FrozenContractV2,
  type InputTraceV2,
  type InterventionSpecV2,
  type JsonPrimitive,
  type JsonValue,
  type MechanismCodeV2,
  type RealizedControlReceiptV1,
  type RunId,
  type ScheduledInputV2,
  type StateSnapshot,
  type V01EnvironmentEventDraft,
  type V03BranchSpec,
  type V03ExecutionComparison,
  type V03ExecutionLog,
  type V03TelemetryEvent,
} from "@chronorift/domain";

import type { GameEnvironmentFactoryPort } from "../ports/game-environment.js";
import type { ClockPort } from "../ports/support.js";
import type { V03ArtifactRepositoryPort } from "../ports/v03-artifact-repository.js";
import type { V03FixtureDefinition } from "../ports/v03-fixture.js";
import { canonicalStringify, jsonEqual } from "./canonical.js";

export interface V03IdGeneratorPort {
  next(
    kind: "branch" | "execution" | "comparison" | "capsule" | "verdict",
  ): string;
}

export class V03GameBranchError extends Error {
  public override readonly name = "V03GameBranchError";

  public constructor(
    public readonly code:
      | "INVALID_FIXTURE"
      | "INVALID_CONTRACT"
      | "INVALID_BRANCH"
      | "INVALID_INTERVENTION"
      | "INVALID_EXECUTION"
      | "INVALID_PROPOSAL"
      | "RUNTIME_PROTOCOL_ERROR",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const contentHash = (value: JsonValue): string =>
  createHash("sha256").update(canonicalStringify(value)).digest("hex");

const contractContent = (
  contract: Omit<FrozenContractV2, "contractId">,
): JsonValue => contract as unknown as JsonValue;

export const v03ContractIdFor = (
  contract: Omit<FrozenContractV2, "contractId">,
) => asContractId(`contract:v2:${contentHash(contractContent(contract))}`);

const traceContent = (trace: Omit<InputTraceV2, "inputTraceId">): JsonValue =>
  trace as unknown as JsonValue;

export const v03InputTraceIdFor = (trace: Omit<InputTraceV2, "inputTraceId">) =>
  asInputTraceId(`trace:v2:${contentHash(traceContent(trace))}`);

const semanticEvent = (
  event: V03TelemetryEvent,
  eventSeqById: ReadonlyMap<string, number>,
): JsonValue => {
  const omitted = new Set([
    "eventId",
    "executionId",
    "runId",
    "branchId",
    "causedByEventId",
  ]);
  const semantic = Object.fromEntries(
    Object.entries(event).filter(([key]) => !omitted.has(key)),
  );
  return {
    ...semantic,
    causedBySeq:
      event.causedByEventId === undefined
        ? null
        : (eventSeqById.get(event.causedByEventId) ?? null),
  };
};

export const v03TimelineDigest = (
  events: readonly V03TelemetryEvent[],
  finalState: StateSnapshot,
): string => {
  const eventSeqById = new Map(
    events.map((event) => [event.eventId, event.seq]),
  );
  return contentHash({
    events: events.map((event) => semanticEvent(event, eventSeqById)),
    finalState,
  } as unknown as JsonValue);
};

const observe = (
  state: StateSnapshot,
  path: string,
): { readonly present: boolean; readonly value?: JsonValue } =>
  Object.prototype.hasOwnProperty.call(state.values, path)
    ? { present: true, value: state.values[path] ?? null }
    : { present: false };

const inputDue = (
  input: ScheduledInputV2,
  relativeTick: number,
  elapsedUs: number,
): boolean =>
  input.scheduleBasis === "relative_tick"
    ? input.relativeTick === relativeTick
    : input.relativeTimeUs <= elapsedUs;

const inputLocalId = (tick: number, order: number): string =>
  `input:${tick}:${order}`;

const entityRefFromFields = (
  fields: Readonly<Record<string, JsonValue>>,
): EntityRefV1 | undefined => {
  const stableId = fields["stableId"];
  const incarnation = fields["incarnation"];
  return typeof stableId === "string" &&
    typeof incarnation === "number" &&
    Number.isInteger(incarnation) &&
    incarnation > 0
    ? { stableId, incarnation }
    : undefined;
};

const materializeDraft = (
  draft: V01EnvironmentEventDraft,
  base: {
    readonly schemaVersion: 2;
    readonly eventId: ReturnType<typeof asEventId>;
    readonly executionId: ReturnType<typeof asExecutionId>;
    readonly runId: RunId;
    readonly branchId: ReturnType<typeof asBranchId>;
    readonly seq: number;
    readonly tick: number;
    readonly simTimeUs: number;
    readonly causedByEventId?: ReturnType<typeof asEventId> | undefined;
  },
): V03TelemetryEvent => {
  if (draft.kind === "signal") {
    return {
      ...base,
      kind: "signal",
      source: draft.source,
      name: draft.name,
      arguments: draft.arguments,
    };
  }
  if (draft.kind === "signal_delivery") {
    if (base.causedByEventId === undefined) {
      throw new V03GameBranchError(
        "RUNTIME_PROTOCOL_ERROR",
        "Signal delivery did not resolve its emitted Signal",
      );
    }
    return {
      ...base,
      kind: "signal_delivery",
      causedByEventId: base.causedByEventId,
      source: draft.source,
      name: draft.name,
      receiver: draft.receiver,
      delivered: draft.delivered,
      ...(draft.failureReason === undefined
        ? {}
        : { failureReason: draft.failureReason }),
    };
  }
  if (draft.kind === "property_changed") {
    return {
      ...base,
      kind: "property_changed",
      path: draft.path,
      before: draft.before,
      after: draft.after,
    };
  }
  const eventType = draft.fields["chronoriftEvent"];
  const entity = entityRefFromFields(draft.fields);
  if (
    eventType === "entity_lifecycle" &&
    entity !== undefined &&
    (draft.fields["action"] === "spawned" ||
      draft.fields["action"] === "despawned")
  ) {
    return {
      ...base,
      kind: "entity_lifecycle",
      action: draft.fields["action"],
      entity,
    };
  }
  const x = draft.fields["x"];
  const y = draft.fields["y"];
  if (
    eventType === "spatial_sample" &&
    entity !== undefined &&
    typeof x === "number" &&
    typeof y === "number"
  ) {
    return {
      ...base,
      kind: "spatial_sample",
      entity,
      position: [x, y],
    };
  }
  return {
    ...base,
    kind: "log",
    level: draft.level,
    source: draft.source,
    message: draft.message,
    fields: draft.fields,
  };
};

const evaluateContract = (
  contract: FrozenContractV2,
  events: readonly V03TelemetryEvent[],
  states: ReadonlyMap<number, StateSnapshot>,
): ContractEvaluationV2 => {
  const trigger = events.find(
    (event) =>
      event.kind === "signal" &&
      event.source === contract.rule.trigger.source &&
      event.name === contract.rule.trigger.name,
  );
  if (trigger === undefined) {
    throw new V03GameBranchError(
      "INVALID_EXECUTION",
      "Execution did not emit the frozen Contract trigger",
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
  const satisfiedState = [...states.entries()]
    .filter(
      ([tick, state]) =>
        tick >= trigger.tick &&
        tick <= deadlineTick &&
        observe(state, contract.rule.expectation.path).present &&
        jsonEqual(
          observe(state, contract.rule.expectation.path).value ?? null,
          contract.rule.expectation.value,
        ),
    )
    .sort(([left], [right]) => left - right)[0];
  if (satisfiedState !== undefined) {
    return {
      status: "pass",
      triggerEventId: trigger.eventId,
      triggerTick: trigger.tick,
      deadlineTick,
      observed: { present: true, value: contract.rule.expectation.value },
      satisfiedTick: satisfiedState[0],
    };
  }
  const deadlineState = states.get(deadlineTick);
  const lastState = [...states.entries()]
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

const requestedControls = (
  fixture: V03FixtureDefinition,
  controls: BranchControls,
): Readonly<Record<string, JsonPrimitive>> => {
  const requested: Record<string, JsonPrimitive> = {
    fixed_fps:
      typeof controls.variables["fixed_fps"] === "number"
        ? controls.variables["fixed_fps"]
        : (fixture.initialCheckpointContent.environment.runtimeFingerprint
            ?.fixedFps ?? 60),
    physics_ticks_per_second:
      typeof controls.variables["physics_ticks_per_second"] === "number"
        ? controls.variables["physics_ticks_per_second"]
        : (fixture.initialCheckpointContent.environment.runtimeFingerprint
            ?.physicsTicksPerSecond ?? 60),
  };
  for (const [name, fallback] of Object.entries(
    fixture.fixtureControlDefaults,
  )) {
    const value = controls.variables[`fixture.${name}`];
    requested[`fixture.${name}`] =
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
        ? value
        : fallback;
  }
  return requested;
};

const controlReceipt = (
  fixture: V03FixtureDefinition,
  controls: BranchControls,
  runtimeFingerprint: V03ExecutionLog["runtimeFingerprint"],
  restoreState: StateSnapshot,
): RealizedControlReceiptV1 => {
  const requested = requestedControls(fixture, controls);
  const realized: Record<string, JsonPrimitive> = {
    fixed_fps: runtimeFingerprint?.fixedFps ?? -1,
    physics_ticks_per_second: runtimeFingerprint?.physicsTicksPerSecond ?? -1,
  };
  for (const name of Object.keys(fixture.fixtureControlDefaults)) {
    const key = `fixture.${name}`;
    const value = restoreState.values[`control.${name}`];
    realized[key] =
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
        ? value
        : "missing";
  }
  const mismatches = Object.keys(requested)
    .sort()
    .filter((key) => !jsonEqual(requested[key] ?? null, realized[key] ?? null))
    .map(
      (key) =>
        `${key}: requested ${JSON.stringify(requested[key])}, realized ${JSON.stringify(realized[key])}`,
    );
  return {
    schemaVersion: 1,
    requested,
    realized,
    accepted: mismatches.length === 0,
    mismatches,
  };
};

const applyIntervention = (
  trace: InputTraceV2,
  controls: BranchControls,
  intervention: InterventionSpecV2,
): { readonly trace: InputTraceV2; readonly controls: BranchControls } => {
  let nextInputs = [...trace.inputs];
  let nextControls: BranchControls = structuredClone(controls);
  if (intervention.kind === "shift_input") {
    let found = false;
    nextInputs = trace.inputs.map((input) => {
      if (input.order !== intervention.inputOrder) return input;
      found = true;
      return input.scheduleBasis === "relative_tick"
        ? {
            ...input,
            relativeTick: input.relativeTick + intervention.deltaTicks,
          }
        : {
            ...input,
            relativeTimeUs:
              input.relativeTimeUs + intervention.deltaTicks * controls.deltaUs,
          };
    });
    if (!found) {
      throw new V03GameBranchError(
        "INVALID_INTERVENTION",
        `Input order ${intervention.inputOrder} does not exist`,
      );
    }
  } else if (intervention.kind === "set_runtime_control") {
    const variables = {
      ...controls.variables,
      [intervention.name]: intervention.value,
    };
    nextControls = {
      ...controls,
      ...(intervention.name === "fixed_fps"
        ? { deltaUs: Math.round(1_000_000 / intervention.value) }
        : {}),
      variables,
    };
  } else {
    nextControls = {
      ...controls,
      variables: {
        ...controls.variables,
        [`fixture.${intervention.name}`]: intervention.value,
      },
    };
  }
  const withoutId = { schemaVersion: 2 as const, inputs: nextInputs };
  return {
    trace: InputTraceV2Schema.parse({
      ...withoutId,
      inputTraceId: v03InputTraceIdFor(withoutId),
    }),
    controls: nextControls,
  };
};

const evidenceRole = (event: V03TelemetryEvent): EvidenceLinkV2["role"] => {
  switch (event.kind) {
    case "signal":
    case "input":
      return "trigger";
    case "signal_delivery":
      return "delivery";
    case "property_changed":
      return "state_transition";
    case "entity_lifecycle":
      return "lifecycle";
    case "spatial_sample":
      return "spatial_sample";
    case "log":
      return "runtime_log";
  }
};

const firstDivergenceTick = (
  left: V03ExecutionLog,
  right: V03ExecutionLog,
): number | null => {
  const leftSeqById = new Map(
    left.events.map((event) => [event.eventId, event.seq]),
  );
  const rightSeqById = new Map(
    right.events.map((event) => [event.eventId, event.seq]),
  );
  const length = Math.max(left.events.length, right.events.length);
  for (let index = 0; index < length; index += 1) {
    const leftEvent = left.events[index];
    const rightEvent = right.events[index];
    if (
      leftEvent === undefined ||
      rightEvent === undefined ||
      canonicalStringify(semanticEvent(leftEvent, leftSeqById)) !==
        canonicalStringify(semanticEvent(rightEvent, rightSeqById))
    ) {
      return leftEvent?.tick ?? rightEvent?.tick ?? 0;
    }
  }
  return null;
};

export class V03GameBranchService {
  private readonly usedInterventions = new Map<ExecutionId, Set<string>>();

  public constructor(
    private readonly repository: V03ArtifactRepositoryPort,
    private readonly environments: GameEnvironmentFactoryPort,
    private readonly fixture: V03FixtureDefinition,
    private readonly ids: V03IdGeneratorPort,
    private readonly clock: ClockPort,
  ) {}

  public async initialize(runId: RunId): Promise<{
    readonly contract: FrozenContractV2;
    readonly checkpoint: Checkpoint;
    readonly branch: V03BranchSpec;
  }> {
    const contract = FrozenContractV2Schema.parse({
      ...this.fixture.contractInput,
      contractId: v03ContractIdFor(this.fixture.contractInput),
    });
    if (contract.fixtureId !== this.fixture.fixtureId) {
      throw new V03GameBranchError(
        "INVALID_FIXTURE",
        "Fixture and Contract fixture IDs differ",
      );
    }
    const trace = InputTraceV2Schema.parse(this.fixture.inputTrace);
    if (
      trace.inputTraceId !==
      v03InputTraceIdFor({ schemaVersion: 2, inputs: trace.inputs })
    ) {
      throw new V03GameBranchError(
        "INVALID_BRANCH",
        "Input trace content hash is invalid",
      );
    }
    const candidates = this.fixture.experiments.map((candidate) =>
      ExperimentCandidateV1Schema.parse(candidate),
    );
    if (
      candidates.length !== 2 ||
      new Set(candidates.map((candidate) => candidate.interventionId)).size !==
        2
    ) {
      throw new V03GameBranchError(
        "INVALID_FIXTURE",
        "v0.3 fixtures require exactly two unique experiments",
      );
    }
    await this.repository.putContract(contract);
    await this.repository.putInputTrace(trace);
    const checkpoint = await this.repository.putCheckpoint(
      this.fixture.initialCheckpointContent,
    );
    const branch = V03BranchSpecSchema.parse({
      schemaVersion: 2,
      branchId: asBranchId(this.ids.next("branch")),
      runId,
      fixtureId: this.fixture.fixtureId,
      branchKind: "baseline",
      contractId: contract.contractId,
      startCheckpointId: checkpoint.checkpointId,
      inputTraceId: trace.inputTraceId,
      controls: this.fixture.baselineControls,
      createdAt: this.clock.nowIso(),
    });
    await this.repository.putBranch(branch);
    return { contract, checkpoint, branch };
  }

  public listExperiments(): readonly ExperimentCandidateV1[] {
    return structuredClone(this.fixture.experiments);
  }

  public async execute(
    branchId: ReturnType<typeof asBranchId>,
  ): Promise<V03ExecutionLog> {
    const branch = V03BranchSpecSchema.parse(
      await this.repository.getBranch(branchId),
    );
    const contract = FrozenContractV2Schema.parse(
      await this.repository.getContract(branch.contractId),
    );
    const checkpoint = CheckpointSchema.parse(
      await this.repository.getCheckpoint(branch.startCheckpointId),
    );
    const trace = InputTraceV2Schema.parse(
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
        properties: [
          ...new Set([
            contract.rule.expectation.path,
            ...this.fixture.probeProperties,
          ]),
        ],
      },
    });
    try {
      const restored = await environment.restore({
        snapshot: checkpoint.content.snapshot,
        nextTick: checkpoint.content.nextTick,
        simTimeUs: checkpoint.content.simTimeUs,
        ...(checkpoint.content.certificate === undefined
          ? {}
          : { certificate: checkpoint.content.certificate }),
      });
      const receipt = controlReceipt(
        this.fixture,
        branch.controls,
        environment.descriptor.runtimeFingerprint,
        restored.state,
      );
      const events: V03TelemetryEvent[] = [];
      const localIds = new Map<string, ReturnType<typeof asEventId>>();
      const states = new Map<number, StateSnapshot>();
      const appliedOrders = new Set<number>();
      let nextTick = restored.nextTick;
      let simTimeUs = restored.simTimeUs;
      let elapsedUs = 0;
      let droppedEvents = 0;
      let truncatedEvents = 0;
      let emittedEvents = 0;
      let bufferedBytes = 0;
      let probeOverheadUs = 0;
      let backpressure = false;
      for (
        let relativeTick = 0;
        relativeTick <= branch.controls.maxTicks;
        relativeTick += 1
      ) {
        const scheduled = trace.inputs
          .filter(
            (input) =>
              !appliedOrders.has(input.order) &&
              inputDue(input, relativeTick, elapsedUs),
          )
          .sort((left, right) => left.order - right.order);
        const runtimeInputs = scheduled.map((input) => ({
          localId: inputLocalId(nextTick, input.order),
          order: input.order,
          action: input.action,
          ...(input.target === undefined ? {} : { target: input.target }),
          payload: input.payload,
        }));
        for (const input of runtimeInputs) {
          const eventId = asEventId(`event:${executionId}:${events.length}`);
          localIds.set(input.localId, eventId);
          events.push({
            schemaVersion: 2,
            eventId,
            executionId,
            runId: branch.runId,
            branchId: branch.branchId,
            seq: events.length,
            tick: nextTick,
            simTimeUs,
            kind: "input",
            order: input.order,
            action: input.action,
            ...(input.target === undefined ? {} : { target: input.target }),
            payload: input.payload,
            requestedTick: nextTick,
            realizedTick: nextTick,
          });
          appliedOrders.add(input.order);
        }
        const observation = await environment.step({
          tick: nextTick,
          simTimeUs,
          deltaUs: branch.controls.deltaUs,
          inputs: runtimeInputs,
        });
        if (
          observation.receipt.requestedTick !== nextTick ||
          observation.receipt.realizedTick !== nextTick ||
          observation.receipt.requestedDeltaUs !== branch.controls.deltaUs
        ) {
          throw new V03GameBranchError(
            "RUNTIME_PROTOCOL_ERROR",
            "Runtime step receipt does not match the request",
          );
        }
        for (const draft of observation.events) {
          const eventId = asEventId(`event:${executionId}:${events.length}`);
          const cause =
            draft.causedByLocalId === undefined
              ? undefined
              : localIds.get(draft.causedByLocalId);
          if (draft.causedByLocalId !== undefined && cause === undefined) {
            throw new V03GameBranchError(
              "RUNTIME_PROTOCOL_ERROR",
              `Unresolved causal local ID ${draft.causedByLocalId}`,
            );
          }
          const event = materializeDraft(draft, {
            schemaVersion: 2,
            eventId,
            executionId,
            runId: branch.runId,
            branchId: branch.branchId,
            seq: events.length,
            tick: nextTick,
            simTimeUs,
            ...(cause === undefined ? {} : { causedByEventId: cause }),
          });
          events.push(event);
          localIds.set(draft.localId, eventId);
        }
        states.set(nextTick, observation.state);
        const health = observation.receipt.runtime?.observationHealth;
        if (health !== undefined) {
          droppedEvents += health.droppedEvents;
          truncatedEvents += health.truncatedEvents;
          emittedEvents += health.emittedEvents;
          bufferedBytes = Math.max(bufferedBytes, health.bufferedBytes);
          probeOverheadUs += health.probeOverheadUs;
          backpressure ||= health.backpressure;
        }
        const realizedDelta = observation.receipt.realizedDeltaUs;
        elapsedUs += realizedDelta;
        simTimeUs += realizedDelta;
        nextTick += 1;
      }
      const finalState = states.get(nextTick - 1) ?? restored.state;
      const evaluation = evaluateContract(contract, events, states);
      const execution = V03ExecutionLogSchema.parse({
        schemaVersion: 2,
        executionId,
        runId: branch.runId,
        fixtureId: branch.fixtureId,
        branchId: branch.branchId,
        contractId: branch.contractId,
        startCheckpointId: branch.startCheckpointId,
        inputTraceId: branch.inputTraceId,
        status: "completed",
        evaluation,
        controlReceipt: receipt,
        observationHealth: {
          schemaVersion: 1,
          emittedEvents,
          droppedEvents,
          truncatedEvents,
          bufferedBytes,
          backpressure,
          probeOverheadUs,
        },
        events,
        finalState,
        timelineDigest: v03TimelineDigest(events, finalState),
        sealed: true,
        ...(environment.descriptor.runtimeFingerprint === undefined
          ? {}
          : { runtimeFingerprint: environment.descriptor.runtimeFingerprint }),
      });
      await this.repository.putExecution(execution);
      return execution;
    } finally {
      await environment.dispose();
    }
  }

  public async replayExecution(executionId: ExecutionId): Promise<{
    readonly execution: V03ExecutionLog;
    readonly matches: boolean;
    readonly sourceDigest: string;
    readonly replayDigest: string;
  }> {
    const source = await this.repository.getExecution(executionId);
    const replay = await this.execute(source.branchId);
    return {
      execution: replay,
      matches: source.timelineDigest === replay.timelineDigest,
      sourceDigest: source.timelineDigest,
      replayDigest: replay.timelineDigest,
    };
  }

  public async runIntervention(
    baselineExecutionId: ExecutionId,
    interventionId: ExperimentCandidateV1["interventionId"],
  ): Promise<{
    readonly branch: V03BranchSpec;
    readonly execution: V03ExecutionLog;
  }> {
    const baseline = await this.repository.getExecution(baselineExecutionId);
    const parent = await this.repository.getBranch(baseline.branchId);
    if (parent.branchKind !== "baseline") {
      throw new V03GameBranchError(
        "INVALID_INTERVENTION",
        "Interventions must descend from the protected baseline",
      );
    }
    const used = this.usedInterventions.get(baselineExecutionId) ?? new Set();
    if (used.size >= 2) {
      throw new V03GameBranchError(
        "INVALID_INTERVENTION",
        "v0.3 permits at most two interventions per baseline",
      );
    }
    if (used.has(interventionId)) {
      throw new V03GameBranchError(
        "INVALID_INTERVENTION",
        `Intervention ${interventionId} was already used`,
      );
    }
    const candidate = this.fixture.experiments.find(
      (entry) => entry.interventionId === interventionId,
    );
    if (candidate === undefined) {
      throw new V03GameBranchError(
        "INVALID_INTERVENTION",
        `Intervention ${interventionId} is not allowlisted for this Fixture`,
      );
    }
    const baselineTrace = await this.repository.getInputTrace(
      parent.inputTraceId,
    );
    const transformed = applyIntervention(
      baselineTrace,
      parent.controls,
      candidate.intervention,
    );
    await this.repository.putInputTrace(transformed.trace);
    const branch = V03BranchSpecSchema.parse({
      ...parent,
      branchId: asBranchId(this.ids.next("branch")),
      branchKind: "intervention",
      parentBranchId: parent.branchId,
      interventionId,
      intervention: candidate.intervention,
      inputTraceId: transformed.trace.inputTraceId,
      controls: transformed.controls,
      createdAt: this.clock.nowIso(),
    });
    await this.repository.putBranch(branch);
    used.add(interventionId);
    this.usedInterventions.set(baselineExecutionId, used);
    return { branch, execution: await this.execute(branch.branchId) };
  }

  public async compareExecutions(
    baselineExecutionId: ExecutionId,
    candidateExecutionId: ExecutionId,
  ): Promise<V03ExecutionComparison> {
    const baseline = await this.repository.getExecution(baselineExecutionId);
    const candidate = await this.repository.getExecution(candidateExecutionId);
    const baselineBranch = await this.repository.getBranch(baseline.branchId);
    const candidateBranch = await this.repository.getBranch(candidate.branchId);
    const blockers: string[] = [];
    if (
      candidateBranch.branchKind !== "intervention" ||
      baselineBranch.branchKind !== "baseline"
    ) {
      blockers.push("Comparison requires a baseline and intervention branch");
    }
    if (
      baseline.runId !== candidate.runId ||
      baseline.fixtureId !== candidate.fixtureId ||
      baseline.contractId !== candidate.contractId ||
      baseline.startCheckpointId !== candidate.startCheckpointId
    ) {
      blockers.push("Executions do not share investigation lineage");
    }
    if (!candidate.controlReceipt.accepted) {
      blockers.push("Runtime did not realize every requested control");
    }
    if (candidateBranch.branchKind !== "intervention") {
      throw new V03GameBranchError(
        "INVALID_INTERVENTION",
        "Candidate branch has no intervention",
      );
    }
    const comparison = V03ExecutionComparisonSchema.parse({
      schemaVersion: 2,
      comparisonId: asComparisonId(this.ids.next("comparison")),
      runId: baseline.runId,
      fixtureId: baseline.fixtureId,
      contractId: baseline.contractId,
      baselineExecutionId,
      candidateExecutionId,
      interventionId: candidateBranch.interventionId,
      intervention: candidateBranch.intervention,
      baselineOutcome: baseline.evaluation.status,
      candidateOutcome: candidate.evaluation.status,
      comparable: blockers.length === 0,
      blockers,
      firstDivergenceTick: firstDivergenceTick(baseline, candidate),
    });
    await this.repository.putComparison(comparison);
    return comparison;
  }

  public async compileEvidence(
    baselineExecutionId: ExecutionId,
  ): Promise<EvidenceCapsuleV2> {
    const execution = await this.repository.getExecution(baselineExecutionId);
    const contract = await this.repository.getContract(execution.contractId);
    if (execution.evaluation.status !== "fail") {
      throw new V03GameBranchError(
        "INVALID_EXECUTION",
        "Evidence Capsule requires a completed failing execution",
      );
    }
    const eventChain = execution.events.filter(
      (event) =>
        event.tick >= execution.evaluation.triggerTick &&
        event.tick <= execution.evaluation.deadlineTick,
    );
    const evidenceLinks = eventChain.map((event) => ({
      role: evidenceRole(event),
      eventId: event.eventId,
    }));
    const capsule = EvidenceCapsuleV2Schema.parse({
      schemaVersion: 2,
      capsuleId: asCapsuleId(this.ids.next("capsule")),
      runId: execution.runId,
      fixtureId: execution.fixtureId,
      contractId: execution.contractId,
      baselineExecutionId,
      checkpointId: execution.startCheckpointId,
      eventChain,
      evidenceLinks,
      expected: contract.rule.expectation,
      actual: execution.evaluation.observed,
      violationSummary: `${contract.rule.expectation.path} did not equal ${JSON.stringify(contract.rule.expectation.value)} within ${contract.rule.withinTicks} ticks`,
      timelineDigest: execution.timelineDigest,
      eventLossDetected:
        execution.observationHealth.droppedEvents > 0 ||
        execution.observationHealth.truncatedEvents > 0 ||
        execution.observationHealth.backpressure,
      knownLimitations: this.fixture.checkpointLimitations,
    });
    await this.repository.putCapsule(capsule);
    return capsule;
  }

  public async conclude(
    proposalInput: DiagnosisProposalV2,
  ): Promise<DiagnosisVerdictV2> {
    const proposal = DiagnosisProposalV2Schema.parse(proposalInput);
    const blockers: string[] = [];
    const capsule = await this.repository.getCapsule(proposal.capsuleId);
    if (
      proposal.runId !== capsule.runId ||
      proposal.fixtureId !== capsule.fixtureId ||
      proposal.baselineExecutionId !== capsule.baselineExecutionId
    ) {
      blockers.push("Proposal does not match the Capsule investigation");
    }
    if (capsule.eventLossDetected)
      blockers.push("Evidence Capsule reports event loss");
    if (proposal.mechanismCode === "unknown") {
      blockers.push("Agent abstained from a typed mechanism claim");
    }
    const replay =
      proposal.replayExecutionId === undefined
        ? undefined
        : await this.repository.getExecution(proposal.replayExecutionId);
    if (
      replay === undefined ||
      replay.branchId !==
        (await this.repository.getExecution(capsule.baselineExecutionId))
          .branchId ||
      replay.timelineDigest !== capsule.timelineDigest ||
      replay.evaluation.status !== "fail"
    ) {
      blockers.push("A matching failing strict replay is required");
    }
    const comparisons = await Promise.all(
      proposal.comparisonIds.map((id) => this.repository.getComparison(id)),
    );
    const passing = comparisons.filter(
      (comparison) =>
        comparison.runId === capsule.runId &&
        comparison.fixtureId === capsule.fixtureId &&
        comparison.baselineExecutionId === capsule.baselineExecutionId &&
        comparison.comparable &&
        comparison.baselineOutcome === "fail" &&
        comparison.candidateOutcome === "pass",
    );
    if (passing.length === 0) {
      blockers.push(
        "No comparable single-variable intervention changed fail to pass",
      );
    }
    const executions = await Promise.all(
      comparisons.map((comparison) =>
        this.repository.getExecution(comparison.candidateExecutionId),
      ),
    );
    const eventIds = new Set([
      ...capsule.eventChain.map((event) => event.eventId),
      ...(replay?.events.map((event) => event.eventId) ?? []),
      ...executions.flatMap((execution) =>
        execution.events.map((event) => event.eventId),
      ),
    ]);
    if (proposal.evidenceEventIds.some((id) => !eventIds.has(id))) {
      blockers.push("Proposal cites an event outside the investigation");
    }
    if (proposal.evidenceEventIds.length === 0) {
      blockers.push("Typed mechanism claims require evidence event references");
    }
    if (
      proposal.mechanismCode !== "unknown" &&
      !this.validateMechanism(
        proposal.mechanismCode,
        capsule,
        passing,
        executions,
      )
    ) {
      blockers.push("Evidence does not validate the proposed mechanism");
    }
    await this.repository.putProposal(proposal);
    const status = blockers.length === 0 ? "confirmed" : "inconclusive";
    const verdict = DiagnosisVerdictV2Schema.parse({
      schemaVersion: 2,
      verdictId: asVerdictId(this.ids.next("verdict")),
      proposalId: proposal.proposalId,
      runId: proposal.runId,
      fixtureId: proposal.fixtureId,
      status,
      mechanismCode: proposal.mechanismCode,
      summary:
        status === "confirmed"
          ? `Harness evidence confirms ${proposal.mechanismCode}`
          : "Evidence is insufficient for a canonical diagnosis",
      blockers,
    });
    await this.repository.putVerdict(verdict);
    return verdict;
  }

  private validateMechanism(
    code: Exclude<MechanismCodeV2, "unknown">,
    capsule: EvidenceCapsuleV2,
    passing: readonly V03ExecutionComparison[],
    candidates: readonly V03ExecutionLog[],
  ): boolean {
    if (code === "signal_before_receiver_connection") {
      const failed = capsule.eventChain.find(
        (event) =>
          event.kind === "signal_delivery" &&
          !event.delivered &&
          event.failureReason === "receiver_not_connected",
      );
      const connected = capsule.eventChain.find(
        (event) =>
          event.kind === "property_changed" &&
          event.path.endsWith("receiver_connected") &&
          event.after === true,
      );
      return (
        failed !== undefined &&
        connected !== undefined &&
        failed.seq < connected.seq &&
        candidates.some((execution) =>
          execution.events.some(
            (event) => event.kind === "signal_delivery" && event.delivered,
          ),
        )
      );
    }
    if (code === "frame_count_used_for_time_window") {
      return passing.some(
        (comparison) =>
          comparison.intervention.kind === "set_runtime_control" &&
          comparison.intervention.name === "fixed_fps",
      );
    }
    if (code === "discrete_physics_tunneling") {
      const hasSpatialEvidence = capsule.eventChain.some(
        (event) => event.kind === "spatial_sample",
      );
      return (
        hasSpatialEvidence &&
        passing.some(
          (comparison) =>
            comparison.intervention.kind === "set_runtime_control" &&
            comparison.intervention.name === "physics_ticks_per_second",
        )
      );
    }
    const lifecycle = capsule.eventChain.filter(
      (event) => event.kind === "entity_lifecycle",
    );
    const incarnations = new Set(
      lifecycle.map(
        (event) =>
          event.kind === "entity_lifecycle" && event.entity.incarnation,
      ),
    );
    return (
      incarnations.size >= 2 &&
      passing.some(
        (comparison) =>
          comparison.intervention.kind === "set_fixture_control" &&
          comparison.intervention.name === "pooling_enabled" &&
          comparison.intervention.value === false,
      )
    );
  }
}
