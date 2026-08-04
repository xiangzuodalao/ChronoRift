import { createHash } from "node:crypto";

import {
  CheckpointSchema,
  DiagnosisProposalV2Schema,
  DiagnosisProposalV3Schema,
  DiagnosisVerdictV2Schema,
  EvidenceAccessReceiptV1Schema,
  EvidenceCapsuleV2Schema,
  ExperimentCandidateV1Schema,
  FrozenContractV2Schema,
  FailureBriefV1Schema,
  InputTraceV2Schema,
  RestoreReceiptSchema,
  StepReceiptSchema,
  V03BranchSpecSchema,
  V03ExecutionComparisonSchema,
  V03ExecutionLogSchema,
  asBranchId,
  asCapsuleId,
  asCheckpointId,
  asComparisonId,
  asContractId,
  asEventId,
  asExecutionId,
  asEvidenceAccessReceiptId,
  asInputTraceId,
  asVerdictId,
  type BranchControls,
  type Checkpoint,
  type ContractEvaluationV2,
  type DiagnosisProposalV2,
  type DiagnosisProposalV3,
  type DiagnosisVerdictV2,
  type EntityRefV1,
  type EvidenceCapsuleV2,
  type EvidenceAccessReceiptV1,
  type EvidenceLinkV2,
  type ExecutionId,
  type ExperimentCandidateV1,
  type FrozenContractV2,
  type FailureBriefV1,
  type InputTraceV2,
  type InterventionSpecV2,
  type JsonPrimitive,
  type JsonValue,
  type MechanismCodeV2,
  type RealizedControlReceiptV1,
  type RestoreReceipt,
  type RuntimeFingerprintV1,
  type RunId,
  type ScheduledInputV2,
  type StateSnapshot,
  type StepReceipt,
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

export const v03EvidenceAccessReceiptIdFor = (
  receipt: Omit<EvidenceAccessReceiptV1, "receiptId" | "issuedAt">,
) =>
  asEvidenceAccessReceiptId(
    `receipt:v1:${contentHash({
      runId: receipt.runId,
      fixtureId: receipt.fixtureId,
      accessKind: receipt.accessKind,
      resourceId: receipt.resourceId,
      requestHash: receipt.requestHash,
      contentHash: receipt.contentHash,
      sourceCoverage: receipt.sourceCoverage,
    } as unknown as JsonValue)}`,
  );

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

export const v03CheckpointIdFor = (content: Checkpoint["content"]) =>
  asCheckpointId(
    `checkpoint:v03:${contentHash(content as unknown as JsonValue)}`,
  );

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

export const v03StateDigest = (state: StateSnapshot): string =>
  contentHash(state as unknown as JsonValue);

const runtimeBuildIdentity = (
  fingerprint: RuntimeFingerprintV1,
): JsonValue => ({
  schemaVersion: fingerprint.schemaVersion,
  engine: fingerprint.engine,
  engineVersion: fingerprint.engineVersion,
  adapterVersion: fingerprint.adapterVersion,
  protocolVersion: fingerprint.protocolVersion,
  platform: fingerprint.platform,
  renderer: fingerprint.renderer,
  projectHash: fingerprint.projectHash,
  addonHash: fingerprint.addonHash,
  capabilities: [...fingerprint.capabilities].sort(),
});

const sameRuntimeBuild = (
  left: RuntimeFingerprintV1 | undefined,
  right: RuntimeFingerprintV1 | undefined,
): boolean =>
  left === undefined || right === undefined
    ? left === right
    : jsonEqual(runtimeBuildIdentity(left), runtimeBuildIdentity(right));

const expectedRestoreState = (
  checkpoint: Checkpoint,
  fixture: V03FixtureDefinition,
  controls: BranchControls,
): StateSnapshot => {
  const values: Record<string, JsonValue> = {
    ...checkpoint.content.snapshot.state.values,
  };
  for (const [name, fallback] of Object.entries(
    fixture.fixtureControlDefaults,
  )) {
    values[`control.${name}`] =
      controls.variables[`fixture.${name}`] ?? fallback;
  }
  return { values };
};

const restoreEvidenceIsAdmissible = (
  checkpoint: Checkpoint,
  receipt: RestoreReceipt,
  runtimeFingerprint: V03ExecutionLog["runtimeFingerprint"],
  fixture: V03FixtureDefinition,
  controls: BranchControls,
): boolean => {
  if (
    receipt.requestedCheckpointId !== checkpoint.checkpointId ||
    receipt.restoredCheckpointId !== checkpoint.checkpointId ||
    receipt.nextTick !== checkpoint.content.nextTick ||
    receipt.simTimeUs !== checkpoint.content.simTimeUs ||
    receipt.stateDigest !==
      v03StateDigest(expectedRestoreState(checkpoint, fixture, controls))
  ) {
    return false;
  }
  if (runtimeFingerprint === undefined) {
    return receipt.runtimeValidation === undefined;
  }
  const certificate = checkpoint.content.certificate;
  const validation = receipt.runtimeValidation;
  if (
    certificate === undefined ||
    validation === undefined ||
    certificate.level !== validation.level ||
    certificate.restoreRecipeHash !==
      contentHash(checkpoint.content.snapshot as unknown as JsonValue) ||
    !sameRuntimeBuild(certificate.environmentFingerprint, runtimeFingerprint) ||
    validation.semanticStateHash !== receipt.stateDigest ||
    certificate.restoreValidation.length === 0 ||
    validation.validations.length !== certificate.restoreValidation.length ||
    certificate.restoreValidation.some(
      (expected) =>
        expected.status !== "pass" ||
        !validation.validations.some(
          (actual) =>
            actual.participantId === expected.participantId &&
            actual.status === "pass" &&
            actual.stateHash === expected.stateHash,
        ),
    )
  ) {
    return false;
  }
  return true;
};

const sameNumberSequence = (
  left: readonly number[],
  right: readonly number[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const executionStepsAreAdmissible = (
  execution: V03ExecutionLog,
  branch: V03BranchSpec,
  checkpoint: Checkpoint,
  trace: InputTraceV2,
): boolean => {
  if (execution.stepReceipts.length !== branch.controls.maxTicks + 1) {
    return false;
  }
  const runtimeReceipts = execution.stepReceipts.flatMap((receipt) =>
    receipt.runtime === undefined ? [] : [receipt.runtime],
  );
  if (
    execution.runtimeFingerprint !== undefined &&
    runtimeReceipts.length !== execution.stepReceipts.length
  ) {
    return false;
  }
  const appliedOrders = new Set<number>();
  let elapsedUs = 0;
  for (const [index, receipt] of execution.stepReceipts.entries()) {
    const expectedTick = checkpoint.content.nextTick + index;
    const scheduled = trace.inputs
      .filter(
        (input) =>
          !appliedOrders.has(input.order) && inputDue(input, index, elapsedUs),
      )
      .sort((left, right) => left.order - right.order);
    const inputEvents = execution.events.filter(
      (event) => event.kind === "input" && event.tick === expectedTick,
    );
    if (
      receipt.requestedTick !== expectedTick ||
      receipt.realizedTick !== expectedTick ||
      receipt.requestedDeltaUs !== branch.controls.deltaUs ||
      receipt.realizedDeltaUs !== receipt.requestedDeltaUs ||
      !sameNumberSequence(
        receipt.appliedInputOrders,
        scheduled.map((input) => input.order),
      ) ||
      inputEvents.length !== scheduled.length ||
      scheduled.some((input, inputIndex) => {
        const event = inputEvents[inputIndex];
        return (
          event?.kind !== "input" ||
          event.order !== input.order ||
          event.action !== input.action ||
          event.target !== input.target ||
          event.requestedTick !== expectedTick ||
          event.realizedTick !== expectedTick ||
          !jsonEqual(event.payload, input.payload)
        );
      })
    ) {
      return false;
    }
    const runtime = receipt.runtime;
    if (
      runtime !== undefined &&
      (runtime.idleFramesExecuted !== 1 ||
        runtime.actualIdleDeltasUs.length !== 1 ||
        runtime.actualIdleDeltasUs[0] !== receipt.realizedDeltaUs ||
        !sameNumberSequence(
          runtime.inputApplications.map((application) => application.order),
          receipt.appliedInputOrders,
        ))
    ) {
      return false;
    }
    for (const input of scheduled) appliedOrders.add(input.order);
    elapsedUs += receipt.realizedDeltaUs;
  }
  if (appliedOrders.size !== trace.inputs.length) return false;
  if (runtimeReceipts.length > 0) {
    const health = runtimeReceipts.map((receipt) => receipt.observationHealth);
    if (
      execution.observationHealth.emittedEvents !==
        health.reduce((total, value) => total + value.emittedEvents, 0) ||
      execution.observationHealth.droppedEvents !==
        health.reduce((total, value) => total + value.droppedEvents, 0) ||
      execution.observationHealth.truncatedEvents !==
        health.reduce((total, value) => total + value.truncatedEvents, 0) ||
      execution.observationHealth.bufferedBytes !==
        Math.max(0, ...health.map((value) => value.bufferedBytes)) ||
      execution.observationHealth.probeOverheadUs !==
        health.reduce((total, value) => total + value.probeOverheadUs, 0) ||
      execution.observationHealth.backpressure !==
        health.some((value) => value.backpressure)
    ) {
      return false;
    }
  }
  return true;
};

export interface BuildFailureBriefV1Options {
  readonly contract: FrozenContractV2;
  readonly capsule: EvidenceCapsuleV2;
  readonly execution: V03ExecutionLog;
}

/** Builds the arm-independent, strictly grounded input for a diagnostic Agent. */
export const buildFailureBriefV1 = (
  options: BuildFailureBriefV1Options,
): FailureBriefV1 => {
  const contract = FrozenContractV2Schema.parse(options.contract);
  const capsule = EvidenceCapsuleV2Schema.parse(options.capsule);
  const execution = V03ExecutionLogSchema.parse(options.execution);
  if (
    execution.evaluation.status !== "fail" ||
    execution.runId !== capsule.runId ||
    execution.fixtureId !== capsule.fixtureId ||
    execution.contractId !== contract.contractId ||
    capsule.contractId !== contract.contractId ||
    execution.executionId !== capsule.baselineExecutionId ||
    execution.startCheckpointId !== capsule.checkpointId ||
    execution.timelineDigest !== capsule.timelineDigest
  ) {
    throw new V03GameBranchError(
      "INVALID_EXECUTION",
      "Failure Brief inputs do not identify the same failing investigation",
    );
  }
  const trigger = execution.events.find(
    (event) => event.eventId === execution.evaluation.triggerEventId,
  );
  if (
    trigger?.kind !== "signal" ||
    trigger.source !== contract.rule.trigger.source ||
    trigger.name !== contract.rule.trigger.name ||
    trigger.tick !== execution.evaluation.triggerTick ||
    !capsule.eventChain.some((event) => event.eventId === trigger.eventId) ||
    execution.evaluation.deadlineTick !==
      execution.evaluation.triggerTick + contract.rule.withinTicks ||
    !jsonEqual(
      capsule.expected as unknown as JsonValue,
      contract.rule.expectation as unknown as JsonValue,
    ) ||
    !jsonEqual(
      capsule.actual as unknown as JsonValue,
      execution.evaluation.observed as unknown as JsonValue,
    )
  ) {
    throw new V03GameBranchError(
      "INVALID_EXECUTION",
      "Failure Brief inputs contain inconsistent Contract evidence",
    );
  }
  return FailureBriefV1Schema.parse({
    schemaVersion: 1,
    runId: execution.runId,
    fixtureId: execution.fixtureId,
    contractId: contract.contractId,
    capsuleId: capsule.capsuleId,
    baselineExecutionId: execution.executionId,
    trigger: contract.rule.trigger,
    triggerEventId: execution.evaluation.triggerEventId,
    triggerTick: execution.evaluation.triggerTick,
    expectation: contract.rule.expectation,
    deadlineTick: execution.evaluation.deadlineTick,
    actual: execution.evaluation.observed,
    violationSummary: capsule.violationSummary,
  });
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

const entityRefFromNamedFields = (
  fields: Readonly<Record<string, JsonValue>>,
  stableIdKey: string,
  incarnationKey: string,
): EntityRefV1 | undefined => {
  const stableId = fields[stableIdKey];
  const incarnation = fields[incarnationKey];
  return typeof stableId === "string" &&
    stableId.length > 0 &&
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
  if (eventType === "pending_effect") {
    const action = draft.fields["action"];
    const effectId = draft.fields["effectId"];
    const target = entityRefFromNamedFields(
      draft.fields,
      "targetStableId",
      "targetIncarnation",
    );
    const resolvedTarget = entityRefFromNamedFields(
      draft.fields,
      "resolvedStableId",
      "resolvedIncarnation",
    );
    const dueTick = draft.fields["dueTick"];
    const reason = draft.fields["reason"];
    if (
      (action !== "scheduled" &&
        action !== "restored" &&
        action !== "applied" &&
        action !== "discarded") ||
      typeof effectId !== "string" ||
      effectId.length === 0 ||
      target === undefined ||
      typeof dueTick !== "number" ||
      !Number.isInteger(dueTick) ||
      dueTick < 0 ||
      (reason !== undefined &&
        reason !== "owner_destroyed" &&
        reason !== "target_missing" &&
        reason !== "stale_incarnation")
    ) {
      throw new V03GameBranchError(
        "RUNTIME_PROTOCOL_ERROR",
        "Malformed pending-effect telemetry",
      );
    }
    return {
      ...base,
      kind: "pending_effect",
      action,
      effectId,
      target,
      ...(resolvedTarget === undefined ? {} : { resolvedTarget }),
      dueTick,
      ...(reason === undefined ? {} : { reason }),
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
    case "pending_effect":
      return "pending_effect";
    case "log":
      return "runtime_log";
  }
};

const causalWindow = (
  events: readonly V03TelemetryEvent[],
  triggerTick: number,
  deadlineTick: number,
): readonly V03TelemetryEvent[] => {
  const byId = new Map(events.map((event) => [event.eventId, event]));
  const selected = new Map(
    events
      .filter(
        (event) => event.tick >= triggerTick && event.tick <= deadlineTick,
      )
      .map((event) => [event.eventId, event]),
  );
  const pending = [...selected.values()];
  while (pending.length > 0) {
    const event = pending.pop();
    if (event?.causedByEventId === undefined) continue;
    const ancestor = byId.get(event.causedByEventId);
    if (ancestor === undefined || selected.has(ancestor.eventId)) continue;
    selected.set(ancestor.eventId, ancestor);
    pending.push(ancestor);
  }
  return [...selected.values()].sort((left, right) => left.seq - right.seq);
};

const causallyDescendsFrom = (
  event: V03TelemetryEvent,
  ancestorId: string,
  events: readonly V03TelemetryEvent[],
): boolean => {
  const byId = new Map(
    events.map((candidate) => [candidate.eventId, candidate]),
  );
  const visited = new Set<string>();
  let current: V03TelemetryEvent | undefined = event;
  while (current.causedByEventId !== undefined) {
    if (current.causedByEventId === ancestorId) return true;
    if (visited.has(current.causedByEventId)) return false;
    visited.add(current.causedByEventId);
    current = byId.get(current.causedByEventId);
    if (current === undefined) return false;
  }
  return false;
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
    if (
      checkpoint.checkpointId !== v03CheckpointIdFor(checkpoint.content) ||
      !jsonEqual(
        checkpoint.content as unknown as JsonValue,
        this.fixture.initialCheckpointContent as unknown as JsonValue,
      )
    ) {
      throw new V03GameBranchError(
        "INVALID_BRANCH",
        "Checkpoint repository returned non-canonical content",
      );
    }
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
      const restoreReceipt = RestoreReceiptSchema.parse({
        requestedCheckpointId: checkpoint.checkpointId,
        restoredCheckpointId: checkpoint.checkpointId,
        restored: true,
        nextTick: restored.nextTick,
        simTimeUs: restored.simTimeUs,
        stateDigest: v03StateDigest(restored.state),
        ...(restored.runtimeValidation === undefined
          ? {}
          : { runtimeValidation: restored.runtimeValidation }),
      });
      if (
        !jsonEqual(
          restored.state as unknown as JsonValue,
          expectedRestoreState(
            checkpoint,
            this.fixture,
            branch.controls,
          ) as unknown as JsonValue,
        ) ||
        !restoreEvidenceIsAdmissible(
          checkpoint,
          restoreReceipt,
          environment.descriptor.runtimeFingerprint,
          this.fixture,
          branch.controls,
        )
      ) {
        throw new V03GameBranchError(
          "RUNTIME_PROTOCOL_ERROR",
          "Runtime restore receipt does not validate the frozen checkpoint",
        );
      }
      const receipt = controlReceipt(
        this.fixture,
        branch.controls,
        environment.descriptor.runtimeFingerprint,
        restored.state,
      );
      const events: V03TelemetryEvent[] = [];
      const stepReceipts: StepReceipt[] = [];
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
        const stepReceipt = StepReceiptSchema.parse(observation.receipt);
        if (
          stepReceipt.requestedTick !== nextTick ||
          stepReceipt.realizedTick !== nextTick ||
          stepReceipt.requestedDeltaUs !== branch.controls.deltaUs ||
          !sameNumberSequence(
            stepReceipt.appliedInputOrders,
            runtimeInputs.map((input) => input.order),
          ) ||
          (environment.descriptor.runtimeFingerprint !== undefined &&
            (stepReceipt.runtime === undefined ||
              stepReceipt.runtime.idleFramesExecuted !== 1 ||
              stepReceipt.runtime.actualIdleDeltasUs[0] !==
                stepReceipt.realizedDeltaUs))
        ) {
          throw new V03GameBranchError(
            "RUNTIME_PROTOCOL_ERROR",
            "Runtime step receipt does not match the request",
          );
        }
        stepReceipts.push(stepReceipt);
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
        const health = stepReceipt.runtime?.observationHealth;
        if (health !== undefined) {
          droppedEvents += health.droppedEvents;
          truncatedEvents += health.truncatedEvents;
          emittedEvents += health.emittedEvents;
          bufferedBytes = Math.max(bufferedBytes, health.bufferedBytes);
          probeOverheadUs += health.probeOverheadUs;
          backpressure ||= health.backpressure;
        }
        const realizedDelta = stepReceipt.realizedDeltaUs;
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
        restoreReceipt,
        stepReceipts,
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
      if (!executionStepsAreAdmissible(execution, branch, checkpoint, trace)) {
        throw new V03GameBranchError(
          "RUNTIME_PROTOCOL_ERROR",
          "Runtime step receipts do not match the sealed execution",
        );
      }
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
    const checkpoint = await this.repository.getCheckpoint(
      baseline.startCheckpointId,
    );
    const baselineBranch = await this.repository.getBranch(baseline.branchId);
    const candidateBranch = await this.repository.getBranch(candidate.branchId);
    const baselineTrace = await this.repository.getInputTrace(
      baselineBranch.inputTraceId,
    );
    const candidateTrace = await this.repository.getInputTrace(
      candidateBranch.inputTraceId,
    );
    const blockers: string[] = [];
    if (
      candidateBranch.branchKind !== "intervention" ||
      baselineBranch.branchKind !== "baseline"
    ) {
      blockers.push("Comparison requires a baseline and intervention branch");
    }
    if (
      candidateBranch.branchKind !== "intervention" ||
      candidateBranch.parentBranchId !== baselineBranch.branchId ||
      candidateBranch.interventionId === undefined ||
      candidateBranch.intervention === undefined
    ) {
      blockers.push("Candidate is not a direct typed intervention branch");
    } else {
      const expected = applyIntervention(
        baselineTrace,
        baselineBranch.controls,
        candidateBranch.intervention,
      );
      if (
        candidateBranch.inputTraceId !== expected.trace.inputTraceId ||
        !jsonEqual(
          candidateBranch.controls as unknown as JsonValue,
          expected.controls as unknown as JsonValue,
        )
      ) {
        blockers.push(
          "Candidate branch changes more than its declared intervention",
        );
      }
    }
    if (
      baseline.runId !== candidate.runId ||
      baseline.fixtureId !== candidate.fixtureId ||
      baseline.contractId !== candidate.contractId ||
      baseline.startCheckpointId !== candidate.startCheckpointId
    ) {
      blockers.push("Executions do not share investigation lineage");
    }
    if (
      baseline.inputTraceId !== baselineBranch.inputTraceId ||
      candidate.inputTraceId !== candidateBranch.inputTraceId ||
      !jsonEqual(
        baseline.controlReceipt.requested,
        requestedControls(this.fixture, baselineBranch.controls),
      ) ||
      !jsonEqual(
        candidate.controlReceipt.requested,
        requestedControls(this.fixture, candidateBranch.controls),
      )
    ) {
      blockers.push("Execution receipts do not match their BranchSpecs");
    }
    if (
      !sameRuntimeBuild(
        baseline.runtimeFingerprint,
        candidate.runtimeFingerprint,
      ) ||
      !restoreEvidenceIsAdmissible(
        checkpoint,
        baseline.restoreReceipt,
        baseline.runtimeFingerprint,
        this.fixture,
        baselineBranch.controls,
      ) ||
      !restoreEvidenceIsAdmissible(
        checkpoint,
        candidate.restoreReceipt,
        candidate.runtimeFingerprint,
        this.fixture,
        candidateBranch.controls,
      ) ||
      !executionStepsAreAdmissible(
        baseline,
        baselineBranch,
        checkpoint,
        baselineTrace,
      ) ||
      !executionStepsAreAdmissible(
        candidate,
        candidateBranch,
        checkpoint,
        candidateTrace,
      )
    ) {
      blockers.push("Executions do not have comparable checkpoint restores");
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
    const eventChain = causalWindow(
      execution.events,
      execution.evaluation.triggerTick,
      execution.evaluation.deadlineTick,
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
    const baseline = await this.repository.getExecution(
      capsule.baselineExecutionId,
    );
    const replay =
      proposal.replayExecutionId === undefined
        ? undefined
        : await this.repository.getExecution(proposal.replayExecutionId);
    if (
      replay === undefined ||
      replay.branchId !== baseline.branchId ||
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
      !validateV03MechanismEvidence(
        proposal.mechanismCode,
        capsule,
        passing,
        executions,
        baseline,
        proposal.evidenceEventIds,
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

  public async concludeV3(
    proposalInput: DiagnosisProposalV3,
    accessReceiptInputs: readonly EvidenceAccessReceiptV1[],
  ): Promise<DiagnosisVerdictV2> {
    const proposal = DiagnosisProposalV3Schema.parse(proposalInput);
    const blockers: string[] = [];
    const block = (message: string): void => {
      if (!blockers.includes(message)) blockers.push(message);
    };
    const resolveReference = async <T>(
      label: string,
      id: string,
      load: () => Promise<T>,
      parse: (value: unknown) => T,
    ): Promise<T | undefined> => {
      try {
        return parse(await load());
      } catch {
        block(`Referenced ${label} ${id} could not be resolved`);
        return undefined;
      }
    };

    const receipts = new Map<string, EvidenceAccessReceiptV1>();
    for (const rawReceipt of accessReceiptInputs) {
      const parsed = EvidenceAccessReceiptV1Schema.safeParse(rawReceipt);
      if (!parsed.success) {
        block("A supplied evidence-access receipt failed strict validation");
        continue;
      }
      if (
        parsed.data.receiptId !==
        v03EvidenceAccessReceiptIdFor({
          schemaVersion: 1,
          runId: parsed.data.runId,
          fixtureId: parsed.data.fixtureId,
          accessKind: parsed.data.accessKind,
          resourceId: parsed.data.resourceId,
          requestHash: parsed.data.requestHash,
          contentHash: parsed.data.contentHash,
          sourceCoverage: parsed.data.sourceCoverage,
        })
      ) {
        block("A supplied evidence-access receipt has an invalid content ID");
        continue;
      }
      if (receipts.has(parsed.data.receiptId)) {
        block("Supplied evidence-access receipt IDs must be unique");
        continue;
      }
      receipts.set(parsed.data.receiptId, parsed.data);
    }
    const referencedReceipts: EvidenceAccessReceiptV1[] = [];
    if (proposal.accessReceiptIds.length === 0) {
      block("At least one evidence-access receipt is required");
    }
    for (const receiptId of proposal.accessReceiptIds) {
      const receipt = receipts.get(receiptId);
      if (receipt === undefined) {
        block(`Referenced evidence-access receipt ${receiptId} is missing`);
        continue;
      }
      referencedReceipts.push(receipt);
      if (
        receipt.runId !== proposal.runId ||
        receipt.fixtureId !== proposal.fixtureId
      ) {
        block(
          `Referenced evidence-access receipt ${receiptId} is outside the investigation`,
        );
      }
    }
    const receiptMatchesKnownResource = (
      receipt: EvidenceAccessReceiptV1,
    ): boolean => {
      switch (receipt.accessKind) {
        case "failure_brief":
          return receipt.resourceId === proposal.capsuleId;
        case "raw_execution":
          return receipt.resourceId === proposal.baselineExecutionId;
        case "capsule":
          return receipt.resourceId === proposal.capsuleId;
        case "replay":
          return receipt.resourceId === proposal.replayExecutionId;
        case "experiment":
          return (
            receipt.resourceId === "experiment-catalog" ||
            proposal.candidateExecutionIds.includes(
              receipt.resourceId as ExecutionId,
            )
          );
        case "comparison":
          return proposal.comparisonIds.includes(
            receipt.resourceId as V03ExecutionComparison["comparisonId"],
          );
        case "source_read":
        case "source_search":
          return receipt.sourceCoverage.length > 0;
      }
    };
    for (const receipt of referencedReceipts) {
      if (!receiptMatchesKnownResource(receipt)) {
        block(
          `Referenced evidence-access receipt ${receipt.receiptId} does not cover a cited resource`,
        );
      }
    }
    if (
      !referencedReceipts.some(
        (receipt) =>
          receipt.accessKind === "failure_brief" &&
          receipt.resourceId === proposal.capsuleId,
      )
    ) {
      block("The initial Failure Brief is not covered by a referenced receipt");
    }
    if (
      proposal.replayExecutionId !== undefined &&
      !referencedReceipts.some(
        (receipt) =>
          receipt.accessKind === "replay" &&
          receipt.resourceId === proposal.replayExecutionId,
      )
    ) {
      block("The cited replay is not covered by a referenced receipt");
    }
    for (const candidateId of proposal.candidateExecutionIds) {
      if (
        !referencedReceipts.some(
          (receipt) =>
            receipt.accessKind === "experiment" &&
            receipt.resourceId === candidateId,
        )
      ) {
        block(
          `Candidate execution ${candidateId} is not covered by a referenced experiment receipt`,
        );
      }
    }
    for (const comparisonId of proposal.comparisonIds) {
      if (
        !referencedReceipts.some(
          (receipt) =>
            receipt.accessKind === "comparison" &&
            receipt.resourceId === comparisonId,
        )
      ) {
        block(
          `Comparison ${comparisonId} is not covered by a referenced comparison receipt`,
        );
      }
    }
    const genericComparisonPath =
      proposal.comparisonIds.length === 0 &&
      referencedReceipts.some(
        (receipt) =>
          receipt.accessKind === "raw_execution" &&
          receipt.resourceId === proposal.baselineExecutionId,
      ) &&
      !referencedReceipts.some(
        (receipt) =>
          receipt.accessKind === "capsule" &&
          receipt.resourceId === proposal.capsuleId,
      );
    if (proposal.suspectedSource !== undefined) {
      const sourceGrounded = referencedReceipts.some(
        (receipt) =>
          (receipt.accessKind === "source_read" ||
            receipt.accessKind === "source_search") &&
          receipt.sourceCoverage.some(
            (coverage) =>
              coverage.virtualPath === proposal.suspectedSource?.path &&
              (proposal.suspectedSource.symbol === undefined ||
                coverage.coveredSymbols.includes(
                  proposal.suspectedSource.symbol,
                )),
          ),
      );
      if (!sourceGrounded) {
        block("Suspected source is not covered by a referenced access receipt");
      }
    }

    const capsule = await resolveReference(
      "Capsule",
      proposal.capsuleId,
      () => this.repository.getCapsule(proposal.capsuleId),
      (value) => EvidenceCapsuleV2Schema.parse(value),
    );
    let baseline: V03ExecutionLog | undefined;
    let baselineBranch: V03BranchSpec | undefined;
    let baselineTrace: InputTraceV2 | undefined;
    let contract: FrozenContractV2 | undefined;
    let checkpoint: Checkpoint | undefined;
    if (capsule !== undefined) {
      if (
        proposal.runId !== capsule.runId ||
        proposal.fixtureId !== capsule.fixtureId ||
        proposal.baselineExecutionId !== capsule.baselineExecutionId
      ) {
        block("Proposal does not match the Capsule investigation");
      }
      if (capsule.eventLossDetected) {
        block("Evidence Capsule reports event loss");
      }
      baseline = await resolveReference(
        "baseline execution",
        capsule.baselineExecutionId,
        () => this.repository.getExecution(capsule.baselineExecutionId),
        (value) => V03ExecutionLogSchema.parse(value),
      );
      if (baseline !== undefined) {
        baselineBranch = await resolveReference(
          "baseline branch",
          baseline.branchId,
          () => this.repository.getBranch(baseline!.branchId),
          (value) => V03BranchSpecSchema.parse(value),
        );
        if (baselineBranch !== undefined) {
          baselineTrace = await resolveReference(
            "baseline input trace",
            baselineBranch.inputTraceId,
            () => this.repository.getInputTrace(baselineBranch!.inputTraceId),
            (value) => InputTraceV2Schema.parse(value),
          );
        }
      }
      contract = await resolveReference(
        "Contract",
        capsule.contractId,
        () => this.repository.getContract(capsule.contractId),
        (value) => FrozenContractV2Schema.parse(value),
      );
      checkpoint = await resolveReference(
        "checkpoint",
        capsule.checkpointId,
        () => this.repository.getCheckpoint(capsule.checkpointId),
        (value) => CheckpointSchema.parse(value),
      );
    }
    if (baseline !== undefined && capsule !== undefined) {
      const expectedWindow = causalWindow(
        baseline.events,
        baseline.evaluation.triggerTick,
        baseline.evaluation.deadlineTick,
      );
      if (
        baseline.runId !== capsule.runId ||
        baseline.fixtureId !== capsule.fixtureId ||
        baseline.contractId !== capsule.contractId ||
        baseline.executionId !== capsule.baselineExecutionId ||
        baseline.startCheckpointId !== capsule.checkpointId ||
        baseline.evaluation.status !== "fail" ||
        baseline.timelineDigest !== capsule.timelineDigest ||
        baseline.timelineDigest !==
          v03TimelineDigest(baseline.events, baseline.finalState) ||
        !baseline.controlReceipt.accepted ||
        !jsonEqual(
          baseline.controlReceipt.requested,
          baseline.controlReceipt.realized,
        ) ||
        baseline.observationHealth.droppedEvents > 0 ||
        baseline.observationHealth.truncatedEvents > 0 ||
        baseline.observationHealth.backpressure ||
        checkpoint === undefined ||
        baselineBranch?.branchKind !== "baseline" ||
        baselineBranch.runId !== baseline.runId ||
        baselineBranch.fixtureId !== baseline.fixtureId ||
        baselineBranch.contractId !== baseline.contractId ||
        baselineBranch.startCheckpointId !== baseline.startCheckpointId ||
        baselineBranch.inputTraceId !== baseline.inputTraceId ||
        baselineTrace?.inputTraceId !== baseline.inputTraceId ||
        (baselineTrace !== undefined &&
          baselineTrace.inputTraceId !==
            v03InputTraceIdFor({
              schemaVersion: 2,
              inputs: baselineTrace.inputs,
            })) ||
        checkpoint.checkpointId !== v03CheckpointIdFor(checkpoint.content) ||
        !jsonEqual(
          baseline.controlReceipt.requested,
          requestedControls(this.fixture, baselineBranch.controls),
        ) ||
        !restoreEvidenceIsAdmissible(
          checkpoint,
          baseline.restoreReceipt,
          baseline.runtimeFingerprint,
          this.fixture,
          baselineBranch.controls,
        ) ||
        !executionStepsAreAdmissible(
          baseline,
          baselineBranch,
          checkpoint,
          baselineTrace,
        ) ||
        !jsonEqual(
          expectedWindow as unknown as JsonValue,
          capsule.eventChain as unknown as JsonValue,
        )
      ) {
        block("Baseline evidence does not pass the canonical integrity Gate");
      }
    }
    if (contract !== undefined && capsule !== undefined) {
      if (
        contract.fixtureId !== capsule.fixtureId ||
        contract.contractId !==
          v03ContractIdFor({
            schemaVersion: 2,
            fixtureId: contract.fixtureId,
            authority: contract.authority,
            rule: contract.rule,
          }) ||
        !jsonEqual(
          contract.rule.expectation as unknown as JsonValue,
          capsule.expected as unknown as JsonValue,
        )
      ) {
        block("Frozen Contract does not match the Capsule");
      }
    }
    if (proposal.mechanismCode === "unknown") {
      block("Agent abstained from a typed mechanism claim");
    }
    if (proposal.blockers.length > 0) {
      block("Agent reported unresolved diagnostic blockers");
    }

    let replay: V03ExecutionLog | undefined;
    if (proposal.replayExecutionId === undefined) {
      block("A matching failing strict replay is required");
    } else {
      replay = await resolveReference(
        "replay execution",
        proposal.replayExecutionId,
        () => this.repository.getExecution(proposal.replayExecutionId!),
        (value) => V03ExecutionLogSchema.parse(value),
      );
      if (
        replay !== undefined &&
        baseline !== undefined &&
        capsule !== undefined &&
        (baselineBranch === undefined ||
          baselineTrace === undefined ||
          replay.executionId === baseline.executionId ||
          replay.runId !== baseline.runId ||
          replay.fixtureId !== baseline.fixtureId ||
          replay.branchId !== baseline.branchId ||
          replay.contractId !== baseline.contractId ||
          replay.startCheckpointId !== baseline.startCheckpointId ||
          replay.inputTraceId !== baseline.inputTraceId ||
          replay.timelineDigest !== capsule.timelineDigest ||
          replay.timelineDigest !==
            v03TimelineDigest(replay.events, replay.finalState) ||
          replay.evaluation.status !== "fail" ||
          !replay.controlReceipt.accepted ||
          !jsonEqual(
            replay.controlReceipt.requested,
            replay.controlReceipt.realized,
          ) ||
          !jsonEqual(
            replay.controlReceipt.requested,
            requestedControls(this.fixture, baselineBranch.controls),
          ) ||
          replay.observationHealth.droppedEvents > 0 ||
          replay.observationHealth.truncatedEvents > 0 ||
          replay.observationHealth.backpressure ||
          checkpoint === undefined ||
          baselineBranch?.branchKind !== "baseline" ||
          !restoreEvidenceIsAdmissible(
            checkpoint,
            replay.restoreReceipt,
            replay.runtimeFingerprint,
            this.fixture,
            baselineBranch.controls,
          ) ||
          !executionStepsAreAdmissible(
            replay,
            baselineBranch,
            checkpoint,
            baselineTrace,
          ) ||
          !sameRuntimeBuild(
            replay.runtimeFingerprint,
            baseline.runtimeFingerprint,
          ))
      ) {
        block("A matching failing strict replay is required");
      }
    }

    const candidateIds = new Set(proposal.candidateExecutionIds);
    if (candidateIds.size === 0) {
      block("At least one explicitly cited candidate execution is required");
    }
    const candidates = new Map<ExecutionId, V03ExecutionLog>();
    for (const candidateId of proposal.candidateExecutionIds) {
      const candidate = await resolveReference(
        "candidate execution",
        candidateId,
        () => this.repository.getExecution(candidateId),
        (value) => V03ExecutionLogSchema.parse(value),
      );
      if (candidate !== undefined) candidates.set(candidateId, candidate);
    }

    const comparisons: V03ExecutionComparison[] = [];
    const agentComparedCandidates = new Set<ExecutionId>();
    for (const comparisonId of proposal.comparisonIds) {
      const comparison = await resolveReference(
        "comparison",
        comparisonId,
        () => this.repository.getComparison(comparisonId),
        (value) => V03ExecutionComparisonSchema.parse(value),
      );
      if (comparison === undefined) continue;
      comparisons.push(comparison);
      agentComparedCandidates.add(comparison.candidateExecutionId);
      if (!candidateIds.has(comparison.candidateExecutionId)) {
        block(
          `Comparison ${comparisonId} cites a candidate the Agent did not explicitly cite`,
        );
      }
    }
    for (const candidateId of proposal.candidateExecutionIds) {
      if (
        agentComparedCandidates.has(candidateId) ||
        !candidates.has(candidateId)
      ) {
        continue;
      }
      if (!genericComparisonPath) {
        block(
          `Candidate execution ${candidateId} has no Agent-cited comparison`,
        );
        continue;
      }
      try {
        comparisons.push(
          await this.compareExecutions(
            proposal.baselineExecutionId,
            candidateId,
          ),
        );
      } catch {
        block(
          `Harness could not create a canonical comparison for candidate ${candidateId}`,
        );
      }
    }

    const branchCache = new Map<string, V03BranchSpec>();
    const passing: V03ExecutionComparison[] = [];
    for (const comparison of comparisons) {
      const candidate = candidates.get(comparison.candidateExecutionId);
      let candidateBranch: V03BranchSpec | undefined;
      let candidateTrace: InputTraceV2 | undefined;
      if (candidate !== undefined) {
        candidateBranch = branchCache.get(candidate.branchId);
        if (candidateBranch === undefined) {
          candidateBranch = await resolveReference(
            "candidate branch",
            candidate.branchId,
            () => this.repository.getBranch(candidate.branchId),
            (value) => V03BranchSpecSchema.parse(value),
          );
          if (candidateBranch !== undefined) {
            branchCache.set(candidate.branchId, candidateBranch);
          }
        }
        if (candidateBranch !== undefined) {
          candidateTrace = await resolveReference(
            "candidate input trace",
            candidateBranch.inputTraceId,
            () => this.repository.getInputTrace(candidateBranch!.inputTraceId),
            (value) => InputTraceV2Schema.parse(value),
          );
        }
      }
      const valid =
        baseline !== undefined &&
        capsule !== undefined &&
        baselineBranch?.branchKind === "baseline" &&
        candidate !== undefined &&
        candidateBranch?.branchKind === "intervention" &&
        candidateBranch.parentBranchId === baseline.branchId &&
        candidateBranch.runId === baseline.runId &&
        candidateBranch.fixtureId === baseline.fixtureId &&
        candidateBranch.contractId === baseline.contractId &&
        candidateBranch.startCheckpointId === baseline.startCheckpointId &&
        candidate.inputTraceId === candidateBranch.inputTraceId &&
        candidateTrace !== undefined &&
        candidateTrace.inputTraceId === candidateBranch.inputTraceId &&
        baselineTrace !== undefined &&
        (() => {
          const expected = applyIntervention(
            baselineTrace,
            baselineBranch.controls,
            candidateBranch.intervention,
          );
          return (
            candidateBranch.inputTraceId === expected.trace.inputTraceId &&
            jsonEqual(
              candidateBranch.controls as unknown as JsonValue,
              expected.controls as unknown as JsonValue,
            )
          );
        })() &&
        comparison.runId === capsule.runId &&
        comparison.fixtureId === capsule.fixtureId &&
        comparison.contractId === capsule.contractId &&
        comparison.baselineExecutionId === baseline.executionId &&
        comparison.candidateExecutionId === candidate.executionId &&
        comparison.interventionId === candidateBranch.interventionId &&
        jsonEqual(comparison.intervention, candidateBranch.intervention) &&
        comparison.comparable &&
        comparison.blockers.length === 0 &&
        comparison.baselineOutcome === baseline.evaluation.status &&
        comparison.candidateOutcome === candidate.evaluation.status &&
        baseline.evaluation.status === "fail" &&
        candidate.evaluation.status === "pass" &&
        candidate.runId === baseline.runId &&
        candidate.fixtureId === baseline.fixtureId &&
        candidate.contractId === baseline.contractId &&
        candidate.startCheckpointId === baseline.startCheckpointId &&
        candidate.controlReceipt.accepted &&
        jsonEqual(
          candidate.controlReceipt.requested,
          requestedControls(this.fixture, candidateBranch.controls),
        ) &&
        jsonEqual(
          candidate.controlReceipt.requested,
          candidate.controlReceipt.realized,
        ) &&
        candidate.observationHealth.droppedEvents === 0 &&
        candidate.observationHealth.truncatedEvents === 0 &&
        !candidate.observationHealth.backpressure &&
        checkpoint !== undefined &&
        restoreEvidenceIsAdmissible(
          checkpoint,
          candidate.restoreReceipt,
          candidate.runtimeFingerprint,
          this.fixture,
          candidateBranch.controls,
        ) &&
        executionStepsAreAdmissible(
          candidate,
          candidateBranch,
          checkpoint,
          candidateTrace,
        ) &&
        sameRuntimeBuild(
          candidate.runtimeFingerprint,
          baseline.runtimeFingerprint,
        ) &&
        candidate.timelineDigest ===
          v03TimelineDigest(candidate.events, candidate.finalState);
      if (valid) {
        passing.push(comparison);
      } else {
        block(
          `Comparison ${comparison.comparisonId} does not pass the canonical comparison Gate`,
        );
      }
    }
    if (passing.length === 0) {
      block("No comparable single-variable intervention changed fail to pass");
    }

    const passingCandidateIds = new Set(
      passing.map((comparison) => comparison.candidateExecutionId),
    );
    const passingCandidates = [...candidates.values()].filter((candidate) =>
      passingCandidateIds.has(candidate.executionId),
    );
    let groundedFailureBrief: FailureBriefV1 | undefined;
    if (
      contract !== undefined &&
      capsule !== undefined &&
      baseline !== undefined
    ) {
      try {
        groundedFailureBrief = buildFailureBriefV1({
          contract,
          capsule,
          execution: baseline,
        });
      } catch {
        // The baseline integrity blocker above is the canonical diagnostic.
      }
    }
    for (const receipt of referencedReceipts) {
      let expectedRequest: JsonValue | undefined;
      let expectedContent: JsonValue | undefined;
      const alternateContents: JsonValue[] = [];
      if (receipt.accessKind === "failure_brief") {
        expectedRequest = { delivery: "initial_prompt" };
        expectedContent = groundedFailureBrief as unknown as JsonValue;
      } else if (receipt.accessKind === "raw_execution") {
        expectedRequest = { executionId: proposal.baselineExecutionId };
        expectedContent =
          baseline === undefined
            ? undefined
            : ({
                schemaVersion: 1,
                execution: baseline,
              } as unknown as JsonValue);
      } else if (receipt.accessKind === "capsule") {
        expectedRequest = { capsuleId: proposal.capsuleId };
        expectedContent = capsule as unknown as JsonValue;
      } else if (receipt.accessKind === "replay") {
        expectedRequest = { executionId: proposal.baselineExecutionId };
        expectedContent =
          replay === undefined || capsule === undefined
            ? undefined
            : ({
                execution: replay,
                matches: replay.timelineDigest === capsule.timelineDigest,
                sourceDigest: capsule.timelineDigest,
                replayDigest: replay.timelineDigest,
              } as unknown as JsonValue);
      } else if (
        receipt.accessKind === "experiment" &&
        receipt.resourceId === "experiment-catalog"
      ) {
        expectedRequest = {};
        expectedContent = this.fixture.experiments as unknown as JsonValue;
      } else if (receipt.accessKind === "experiment") {
        const candidate = candidates.get(receipt.resourceId as ExecutionId);
        const candidateBranch =
          candidate === undefined
            ? undefined
            : (branchCache.get(candidate.branchId) ??
              (await resolveReference(
                "candidate branch",
                candidate.branchId,
                () => this.repository.getBranch(candidate.branchId),
                (value) => V03BranchSpecSchema.parse(value),
              )));
        if (
          candidate !== undefined &&
          candidateBranch?.branchKind === "intervention"
        ) {
          expectedRequest = {
            baselineExecutionId: proposal.baselineExecutionId,
            interventionId: candidateBranch.interventionId,
          };
          expectedContent = genericComparisonPath
            ? ({
                interventionId: candidateBranch.interventionId,
                executionId: candidate.executionId,
                rawEvents: candidate.events,
                finalState: candidate.finalState,
                contractOutcome: candidate.evaluation.status,
              } as unknown as JsonValue)
            : ({
                interventionId: candidateBranch.interventionId,
                execution: candidate,
              } as unknown as JsonValue);
          alternateContents.push(
            ...(genericComparisonPath
              ? [
                  {
                    interventionId: candidateBranch.interventionId,
                    execution: candidate,
                  } as unknown as JsonValue,
                ]
              : [
                  {
                    interventionId: candidateBranch.interventionId,
                    executionId: candidate.executionId,
                    rawEvents: candidate.events,
                    finalState: candidate.finalState,
                    contractOutcome: candidate.evaluation.status,
                  } as unknown as JsonValue,
                ]),
          );
        }
      } else if (receipt.accessKind === "comparison") {
        const comparison = comparisons.find(
          (candidate) => candidate.comparisonId === receipt.resourceId,
        );
        if (comparison !== undefined) {
          expectedRequest = {
            baselineExecutionId: comparison.baselineExecutionId,
            candidateExecutionId: comparison.candidateExecutionId,
          };
          expectedContent = comparison as unknown as JsonValue;
        }
      }
      if (
        expectedRequest !== undefined &&
        expectedContent !== undefined &&
        (receipt.requestHash !== contentHash(expectedRequest) ||
          ![expectedContent, ...alternateContents].some(
            (material) => receipt.contentHash === contentHash(material),
          ))
      ) {
        block(
          `Referenced evidence-access receipt ${receipt.receiptId} does not match the resolved tool material`,
        );
      }
    }
    const allowedEventIds = new Set([
      ...(capsule?.eventChain.map((event) => event.eventId) ?? []),
      ...(replay?.events.map((event) => event.eventId) ?? []),
      ...passingCandidates.flatMap((candidate) =>
        candidate.events.map((event) => event.eventId),
      ),
    ]);
    if (proposal.evidenceEventIds.length === 0) {
      block("Typed mechanism claims require evidence event references");
    } else if (
      proposal.evidenceEventIds.some((id) => !allowedEventIds.has(id))
    ) {
      block("Proposal cites an event outside the validated investigation");
    }
    if (
      capsule !== undefined &&
      proposal.evidenceEventIds.length > 0 &&
      !proposal.evidenceEventIds.some((id) =>
        capsule.eventChain.some((event) => event.eventId === id),
      )
    ) {
      block("Proposal does not cite causal evidence from the Capsule");
    }
    if (
      capsule !== undefined &&
      proposal.evidenceEventIds.some((id) =>
        capsule.eventChain.some((event) => event.eventId === id),
      ) &&
      !referencedReceipts.some(
        (receipt) =>
          (receipt.accessKind === "raw_execution" &&
            receipt.resourceId === proposal.baselineExecutionId) ||
          (receipt.accessKind === "capsule" &&
            receipt.resourceId === proposal.capsuleId),
      )
    ) {
      block("Cited baseline events are not covered by a referenced receipt");
    }
    if (
      proposal.mechanismCode !== "unknown" &&
      capsule !== undefined &&
      !validateV03MechanismEvidence(
        proposal.mechanismCode,
        capsule,
        passing,
        passingCandidates,
        baseline,
        proposal.evidenceEventIds,
      )
    ) {
      block("Evidence does not validate the proposed mechanism");
    }

    await this.repository.putProposalV3(proposal);
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
}

export const validateV03MechanismEvidence = (
  code: Exclude<MechanismCodeV2, "unknown">,
  capsule: EvidenceCapsuleV2,
  passing: readonly V03ExecutionComparison[],
  candidates: readonly V03ExecutionLog[],
  baseline: V03ExecutionLog | undefined,
  citedEventIds?: readonly string[],
): boolean => {
  const cited =
    citedEventIds === undefined ? undefined : new Set(citedEventIds);
  const citesAll = (
    ...events: readonly { readonly eventId: string }[]
  ): boolean =>
    cited === undefined || events.every((event) => cited.has(event.eventId));
  const candidateFor = (
    comparison: V03ExecutionComparison,
  ): V03ExecutionLog | undefined =>
    candidates.find(
      (execution) => execution.executionId === comparison.candidateExecutionId,
    );
  const processFramesMatch = (execution: V03ExecutionLog): boolean => {
    const callbacks = execution.finalState.values["player.process_callbacks"];
    const realizedFrames = execution.stepReceipts.reduce(
      (total, receipt) => total + (receipt.runtime?.idleFramesExecuted ?? 0),
      0,
    );
    return (
      typeof callbacks === "number" &&
      Number.isInteger(callbacks) &&
      callbacks === realizedFrames &&
      execution.stepReceipts.every(
        (receipt) => receipt.runtime?.idleFramesExecuted === 1,
      )
    );
  };
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
      passing.some((comparison) => {
        if (
          comparison.intervention.kind !== "shift_input" ||
          comparison.intervention.deltaTicks <= 0
        ) {
          return false;
        }
        const candidate = candidateFor(comparison);
        if (candidate === undefined) return false;
        const delivered = candidate.events.find(
          (event) => event.kind === "signal_delivery" && event.delivered,
        );
        const opened = candidate.events.find(
          (event) =>
            event.kind === "property_changed" &&
            event.path === capsule.expected.path &&
            jsonEqual(event.after, capsule.expected.value),
        );
        return (
          delivered?.kind === "signal_delivery" &&
          opened?.kind === "property_changed" &&
          citesAll(failed, connected, delivered, opened) &&
          causallyDescendsFrom(opened, delivered.eventId, candidate.events)
        );
      })
    );
  }
  if (code === "frame_count_used_for_time_window") {
    const opened = capsule.eventChain.find(
      (event) =>
        event.kind === "property_changed" &&
        event.path === "player.window_open" &&
        event.before === false &&
        event.after === true,
    );
    const closed = capsule.eventChain.find(
      (event) =>
        event.kind === "property_changed" &&
        event.path === "player.window_open" &&
        event.before === true &&
        event.after === false &&
        opened !== undefined &&
        event.seq > opened.seq,
    );
    const rejectedInput = capsule.eventChain.find(
      (event) =>
        event.kind === "input" &&
        event.action === "attempt_jump" &&
        closed !== undefined &&
        event.seq > closed.seq,
    );
    if (
      opened === undefined ||
      closed === undefined ||
      rejectedInput === undefined ||
      baseline === undefined ||
      !processFramesMatch(baseline) ||
      capsule.expected.path !== "player.jumping" ||
      capsule.expected.value !== true ||
      capsule.actual.present !== true ||
      capsule.actual.value !== false
    ) {
      return false;
    }
    return passing.some((comparison) => {
      if (
        comparison.intervention.kind !== "set_runtime_control" ||
        comparison.intervention.name !== "fixed_fps"
      ) {
        return false;
      }
      const candidate = candidateFor(comparison);
      if (candidate === undefined || !processFramesMatch(candidate)) {
        return false;
      }
      const candidateOpened = candidate.events.find(
        (event) =>
          event.kind === "property_changed" &&
          event.path === "player.window_open" &&
          event.after === true,
      );
      const acceptedInput = candidate.events.find(
        (event) => event.kind === "input" && event.action === "attempt_jump",
      );
      const jumped = candidate.events.find(
        (event) =>
          event.kind === "property_changed" &&
          event.path === "player.jumping" &&
          event.after === true,
      );
      const candidateClosed = candidate.events.find(
        (event) =>
          event.kind === "property_changed" &&
          event.path === "player.window_open" &&
          event.after === false,
      );
      return (
        candidateOpened !== undefined &&
        acceptedInput?.kind === "input" &&
        jumped?.kind === "property_changed" &&
        citesAll(
          opened,
          closed,
          rejectedInput,
          candidateOpened,
          acceptedInput,
          jumped,
        ) &&
        candidateOpened.seq < acceptedInput.seq &&
        (candidateClosed === undefined ||
          acceptedInput.seq < candidateClosed.seq) &&
        causallyDescendsFrom(jumped, acceptedInput.eventId, candidate.events)
      );
    });
  }
  if (code === "discrete_physics_tunneling") {
    const baselineFire = capsule.eventChain.find(
      (event) => event.kind === "signal" && event.name === "projectile.fired",
    );
    if (baselineFire?.kind !== "signal") return false;
    return passing.some((comparison) => {
      if (
        comparison.intervention.kind !== "set_runtime_control" ||
        comparison.intervention.name !== "physics_ticks_per_second"
      ) {
        return false;
      }
      const candidate = candidateFor(comparison);
      if (candidate === undefined) return false;
      const candidateFire = candidate.events.find(
        (event) => event.kind === "signal" && event.name === "projectile.fired",
      );
      const hit = candidate.events.find(
        (event) =>
          event.kind === "property_changed" &&
          event.path === capsule.expected.path &&
          jsonEqual(event.after, capsule.expected.value),
      );
      if (
        hit?.kind !== "property_changed" ||
        candidateFire?.kind !== "signal"
      ) {
        return false;
      }
      const hitSample = candidate.events.find(
        (event) =>
          event.kind === "spatial_sample" &&
          causallyDescendsFrom(hit, event.eventId, candidate.events),
      );
      if (hitSample?.kind !== "spatial_sample") return false;
      const targetX = hitSample.position[0];
      const crossed = capsule.eventChain.find((event) => {
        if (
          event.kind !== "property_changed" ||
          event.path !== "projectile.x" ||
          typeof event.before !== "number" ||
          typeof event.after !== "number"
        ) {
          return false;
        }
        const crossedTarget =
          (event.before < targetX && event.after > targetX) ||
          (event.before > targetX && event.after < targetX);
        if (!crossedTarget) return false;
        const sample = capsule.eventChain.find(
          (candidateSample) =>
            candidateSample.kind === "spatial_sample" &&
            candidateSample.causedByEventId === event.eventId &&
            candidateSample.position[0] === event.after,
        );
        return (
          sample !== undefined &&
          causallyDescendsFrom(
            event,
            baselineFire.eventId,
            capsule.eventChain,
          ) &&
          citesAll(baselineFire, event, sample)
        );
      });
      const baselineHit = capsule.eventChain.some(
        (event) =>
          event.kind === "property_changed" &&
          event.path === capsule.expected.path &&
          jsonEqual(event.after, capsule.expected.value),
      );
      return (
        crossed !== undefined &&
        causallyDescendsFrom(hit, candidateFire.eventId, candidate.events) &&
        citesAll(candidateFire, hit, hitSample) &&
        !baselineHit
      );
    });
  }
  const scheduled = capsule.eventChain.find(
    (event) => event.kind === "pending_effect" && event.action === "scheduled",
  );
  if (scheduled?.kind !== "pending_effect") return false;
  const despawned = capsule.eventChain.find(
    (event) =>
      event.kind === "entity_lifecycle" &&
      event.action === "despawned" &&
      event.entity.stableId === scheduled.target.stableId &&
      event.entity.incarnation === scheduled.target.incarnation &&
      causallyDescendsFrom(event, scheduled.eventId, capsule.eventChain),
  );
  if (despawned?.kind !== "entity_lifecycle") return false;
  const spawned = capsule.eventChain.find(
    (event) =>
      event.kind === "entity_lifecycle" &&
      event.action === "spawned" &&
      event.entity.stableId === despawned.entity.stableId &&
      event.entity.incarnation !== despawned.entity.incarnation &&
      causallyDescendsFrom(event, despawned.eventId, capsule.eventChain),
  );
  if (spawned?.kind !== "entity_lifecycle") return false;
  const applied = capsule.eventChain.find(
    (event) =>
      event.kind === "pending_effect" &&
      event.action === "applied" &&
      event.effectId === scheduled.effectId &&
      event.target.stableId === despawned.entity.stableId &&
      event.target.incarnation === despawned.entity.incarnation &&
      event.resolvedTarget?.stableId === spawned.entity.stableId &&
      event.resolvedTarget.incarnation === spawned.entity.incarnation &&
      causallyDescendsFrom(event, spawned.eventId, capsule.eventChain),
  );
  if (applied?.kind !== "pending_effect") return false;
  const staleMutation = capsule.eventChain.find(
    (event) =>
      event.kind === "property_changed" &&
      event.path === "enemy.health" &&
      event.after !== capsule.expected.value &&
      causallyDescendsFrom(event, applied.eventId, capsule.eventChain),
  );
  if (staleMutation === undefined) return false;

  return passing.some((comparison) => {
    if (
      comparison.intervention.kind !== "set_fixture_control" ||
      comparison.intervention.name !== "pooling_enabled" ||
      comparison.intervention.value !== false
    ) {
      return false;
    }
    const candidate = candidates.find(
      (execution) => execution.executionId === comparison.candidateExecutionId,
    );
    if (candidate === undefined) return false;
    const discarded = candidate.events.find(
      (event) =>
        event.kind === "pending_effect" &&
        event.action === "discarded" &&
        event.effectId === scheduled.effectId &&
        event.target.stableId === scheduled.target.stableId &&
        event.target.incarnation === scheduled.target.incarnation &&
        event.reason === "owner_destroyed",
    );
    return (
      discarded?.kind === "pending_effect" &&
      citesAll(scheduled, despawned, spawned, applied, staleMutation, discarded)
    );
  });
};
