import type {
  EventId,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  V03ExecutionComparison,
  V03ExecutionLog,
  V03TelemetryEvent,
} from "@chronorift/domain";
import {
  ClaimEvidencePolicyRegistry,
  jsonEqual,
  type ClaimAssertionIssue,
  type ClaimAssertionSchema,
  type ClaimEvidenceContext,
  type ClaimEvidenceDecision,
  type ClaimEvidencePolicy,
} from "@chronorift/gamebranch";

import type { V03FixtureName } from "./v03-fixtures.js";

export const GODOT_CLAIM_MECHANISM_IDS = Object.freeze({
  signalOrdering: "signal_before_receiver_connection",
  frameWindow: "frame_count_used_for_time_window",
  physicsTunneling: "discrete_physics_tunneling",
  entityReuse: "stale_effect_crossed_entity_incarnation",
} as const);

export const GODOT_CLAIM_ASSERTION_SCHEMA_IDS = Object.freeze({
  signalOrdering: "chronorift.godot.signal-before-receiver-connection.v1",
  frameWindow: "chronorift.godot.frame-count-time-window.v1",
  physicsTunneling: "chronorift.godot.discrete-physics-tunneling.v1",
  entityReuse: "chronorift.godot.entity-incarnation-crossing.v1",
} as const);

export interface SignalOrderingAssertion {
  readonly signalSource: string;
  readonly signalName: string;
  readonly receiver: string;
  readonly receiverConnectedPath: string;
  readonly expectedPath: string;
  readonly expectedValue: JsonValue;
  readonly inputOrder: number;
  readonly minimumDeltaTicks: number;
}

export interface FrameWindowAssertion {
  readonly signalSource: string;
  readonly signalName: string;
  readonly windowPath: string;
  readonly windowOpenValue: JsonValue;
  readonly windowClosedValue: JsonValue;
  readonly processCallbacksPath: string;
  readonly inputAction: string;
  readonly expectedPath: string;
  readonly expectedValue: JsonValue;
  readonly baselineActualValue: JsonValue;
  readonly runtimeControlName: "fixed_fps" | "physics_ticks_per_second";
}

export interface PhysicsTunnelingAssertion {
  readonly signalSource: string;
  readonly signalName: string;
  readonly movingEntityStableId: string;
  readonly movementPath: string;
  readonly positionAxis: 0 | 1;
  readonly expectedPath: string;
  readonly expectedValue: JsonValue;
  readonly runtimeControlName: "fixed_fps" | "physics_ticks_per_second";
}

export interface EntityReuseAssertion {
  readonly respawnSignalSource: string;
  readonly respawnSignalName: string;
  readonly entityStableId: string;
  readonly mutationPath: string;
  readonly expectedValue: JsonValue;
  readonly fixtureControlName: string;
  readonly fixtureControlValue: JsonPrimitive;
  readonly discardReason:
    "owner_destroyed" | "target_missing" | "stale_incarnation";
}

const hasOwn = (value: JsonObject, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const stringField = (
  payload: JsonObject,
  key: string,
  issues: ClaimAssertionIssue[],
): string => {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    issues.push({ path: [key], message: "Expected a non-empty string" });
    return "";
  }
  return value;
};

const integerField = (
  payload: JsonObject,
  key: string,
  issues: ClaimAssertionIssue[],
  minimum: number,
): number => {
  const value = payload[key];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum
  ) {
    issues.push({
      path: [key],
      message: `Expected an integer greater than or equal to ${minimum}`,
    });
    return minimum;
  }
  return value;
};

const jsonField = (
  payload: JsonObject,
  key: string,
  issues: ClaimAssertionIssue[],
): JsonValue => {
  if (!hasOwn(payload, key)) {
    issues.push({ path: [key], message: "Required field is missing" });
    return null;
  }
  return payload[key] as JsonValue;
};

const primitiveField = (
  payload: JsonObject,
  key: string,
  issues: ClaimAssertionIssue[],
): JsonPrimitive => {
  const value = jsonField(payload, key, issues);
  if (typeof value === "object" && value !== null) {
    issues.push({ path: [key], message: "Expected a JSON primitive" });
    return null;
  }
  return value;
};

const enumField = <TValue extends string>(
  payload: JsonObject,
  key: string,
  values: readonly TValue[],
  issues: ClaimAssertionIssue[],
): TValue => {
  const value = payload[key];
  if (typeof value !== "string" || !values.includes(value as TValue)) {
    issues.push({
      path: [key],
      message: `Expected one of ${values.join(", ")}`,
    });
    return values[0] as TValue;
  }
  return value as TValue;
};

const strictSchema = <TAssertion>(
  keys: readonly string[],
  decode: (payload: JsonObject, issues: ClaimAssertionIssue[]) => TAssertion,
): ClaimAssertionSchema<TAssertion> => ({
  safeParse: (payload) => {
    const issues: ClaimAssertionIssue[] = [];
    const allowed = new Set(keys);
    for (const key of Object.keys(payload)) {
      if (!allowed.has(key)) {
        issues.push({ path: [key], message: "Unknown assertion field" });
      }
    }
    const data = decode(payload, issues);
    return issues.length === 0
      ? { success: true, data }
      : { success: false, issues };
  },
});

export const SignalOrderingAssertionSchema =
  strictSchema<SignalOrderingAssertion>(
    [
      "signalSource",
      "signalName",
      "receiver",
      "receiverConnectedPath",
      "expectedPath",
      "expectedValue",
      "inputOrder",
      "minimumDeltaTicks",
    ],
    (payload, issues) => ({
      signalSource: stringField(payload, "signalSource", issues),
      signalName: stringField(payload, "signalName", issues),
      receiver: stringField(payload, "receiver", issues),
      receiverConnectedPath: stringField(
        payload,
        "receiverConnectedPath",
        issues,
      ),
      expectedPath: stringField(payload, "expectedPath", issues),
      expectedValue: jsonField(payload, "expectedValue", issues),
      inputOrder: integerField(payload, "inputOrder", issues, 0),
      minimumDeltaTicks: integerField(payload, "minimumDeltaTicks", issues, 1),
    }),
  );

export const FrameWindowAssertionSchema = strictSchema<FrameWindowAssertion>(
  [
    "signalSource",
    "signalName",
    "windowPath",
    "windowOpenValue",
    "windowClosedValue",
    "processCallbacksPath",
    "inputAction",
    "expectedPath",
    "expectedValue",
    "baselineActualValue",
    "runtimeControlName",
  ],
  (payload, issues) => ({
    signalSource: stringField(payload, "signalSource", issues),
    signalName: stringField(payload, "signalName", issues),
    windowPath: stringField(payload, "windowPath", issues),
    windowOpenValue: jsonField(payload, "windowOpenValue", issues),
    windowClosedValue: jsonField(payload, "windowClosedValue", issues),
    processCallbacksPath: stringField(payload, "processCallbacksPath", issues),
    inputAction: stringField(payload, "inputAction", issues),
    expectedPath: stringField(payload, "expectedPath", issues),
    expectedValue: jsonField(payload, "expectedValue", issues),
    baselineActualValue: jsonField(payload, "baselineActualValue", issues),
    runtimeControlName: enumField(
      payload,
      "runtimeControlName",
      ["fixed_fps", "physics_ticks_per_second"],
      issues,
    ),
  }),
);

export const PhysicsTunnelingAssertionSchema =
  strictSchema<PhysicsTunnelingAssertion>(
    [
      "signalSource",
      "signalName",
      "movingEntityStableId",
      "movementPath",
      "positionAxis",
      "expectedPath",
      "expectedValue",
      "runtimeControlName",
    ],
    (payload, issues) => {
      const axis = integerField(payload, "positionAxis", issues, 0);
      if (axis !== 0 && axis !== 1) {
        issues.push({ path: ["positionAxis"], message: "Expected 0 or 1" });
      }
      return {
        signalSource: stringField(payload, "signalSource", issues),
        signalName: stringField(payload, "signalName", issues),
        movingEntityStableId: stringField(
          payload,
          "movingEntityStableId",
          issues,
        ),
        movementPath: stringField(payload, "movementPath", issues),
        positionAxis: axis === 1 ? 1 : 0,
        expectedPath: stringField(payload, "expectedPath", issues),
        expectedValue: jsonField(payload, "expectedValue", issues),
        runtimeControlName: enumField(
          payload,
          "runtimeControlName",
          ["fixed_fps", "physics_ticks_per_second"],
          issues,
        ),
      };
    },
  );

export const EntityReuseAssertionSchema = strictSchema<EntityReuseAssertion>(
  [
    "respawnSignalSource",
    "respawnSignalName",
    "entityStableId",
    "mutationPath",
    "expectedValue",
    "fixtureControlName",
    "fixtureControlValue",
    "discardReason",
  ],
  (payload, issues) => ({
    respawnSignalSource: stringField(payload, "respawnSignalSource", issues),
    respawnSignalName: stringField(payload, "respawnSignalName", issues),
    entityStableId: stringField(payload, "entityStableId", issues),
    mutationPath: stringField(payload, "mutationPath", issues),
    expectedValue: jsonField(payload, "expectedValue", issues),
    fixtureControlName: stringField(payload, "fixtureControlName", issues),
    fixtureControlValue: primitiveField(payload, "fixtureControlValue", issues),
    discardReason: enumField(
      payload,
      "discardReason",
      ["owner_destroyed", "target_missing", "stale_incarnation"],
      issues,
    ),
  }),
);

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

const cited = (
  context: ClaimEvidenceContext,
  events: readonly V03TelemetryEvent[],
): boolean => {
  const ids = new Set(context.citedEventIds);
  return events.every((event) => ids.has(event.eventId));
};

const fail = (
  code: string,
  message: string,
  events: readonly V03TelemetryEvent[] = [],
): ClaimEvidenceDecision => ({
  supported: false,
  blockers: [
    {
      code,
      message,
      ...(events.length === 0
        ? {}
        : { eventIds: events.map((event) => event.eventId) }),
    },
  ],
});

const supported = (): ClaimEvidenceDecision => ({
  supported: true,
  blockers: [],
});

const candidatePairs = (
  context: ClaimEvidenceContext,
): readonly {
  readonly comparison: V03ExecutionComparison;
  readonly candidate: V03ExecutionLog;
}[] =>
  context.comparisons.flatMap((comparison) => {
    if (
      !comparison.comparable ||
      comparison.blockers.length > 0 ||
      comparison.baselineOutcome !== "fail" ||
      comparison.candidateOutcome !== "pass" ||
      comparison.baselineExecutionId !== context.baselineExecution.executionId
    ) {
      return [];
    }
    const candidate = context.candidateExecutions.find(
      (execution) => execution.executionId === comparison.candidateExecutionId,
    );
    return candidate === undefined ? [] : [{ comparison, candidate }];
  });

const capsuleExpectationMatches = (
  context: ClaimEvidenceContext,
  path: string,
  expected: JsonValue,
): boolean =>
  context.capsule.expected.path === path &&
  jsonEqual(context.capsule.expected.value, expected);

const processFramesMatch = (
  execution: V03ExecutionLog,
  callbacksPath: string,
): boolean => {
  const callbacks = execution.finalState.values[callbacksPath];
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

export const createSignalOrderingClaimEvidencePolicy =
  (): ClaimEvidencePolicy<SignalOrderingAssertion> => ({
    descriptor: {
      policyId: "godot.signal-ordering-evidence",
      policyVersion: "1.0.0",
      mechanismId: GODOT_CLAIM_MECHANISM_IDS.signalOrdering,
      assertionSchemaId: GODOT_CLAIM_ASSERTION_SCHEMA_IDS.signalOrdering,
    },
    agentContract: {
      mechanismDescription:
        "A signal is emitted before its intended receiver is connected, so the delivery is missed and the expected state change does not occur.",
      evidenceRequirements: [
        "Cite the baseline signal emission that starts the asserted causal chain.",
        "Cite the baseline failed delivery to the intended receiver.",
        "Cite the later baseline property change that establishes receiver connection.",
        "Cite the candidate signal emission after the timing intervention.",
        "Cite the candidate successful delivery to the intended receiver.",
        "Cite the candidate property change to the asserted expected state.",
      ],
      additionalProperties: false,
      assertionFields: [
        {
          name: "signalSource",
          type: "string",
          required: true,
          description: "Telemetry source that emitted the signal.",
        },
        {
          name: "signalName",
          type: "string",
          required: true,
          description: "Exact emitted signal name recorded by telemetry.",
        },
        {
          name: "receiver",
          type: "string",
          required: true,
          description:
            "Intended receiver recorded by signal-delivery telemetry.",
        },
        {
          name: "receiverConnectedPath",
          type: "string",
          required: true,
          description:
            "Observed property path whose later true value establishes receiver connection.",
        },
        {
          name: "expectedPath",
          type: "string",
          required: true,
          description:
            "Contract property path expected to change after delivery.",
        },
        {
          name: "expectedValue",
          type: "json",
          required: true,
          description: "Contract value expected at expectedPath.",
        },
        {
          name: "inputOrder",
          type: "integer",
          required: true,
          description:
            "Zero-based input index shifted by the single-variable intervention.",
          minimum: 0,
        },
        {
          name: "minimumDeltaTicks",
          type: "integer",
          required: true,
          description:
            "Minimum positive tick shift required from the intervention comparison.",
          minimum: 1,
        },
      ],
    },
    assertionSchema: SignalOrderingAssertionSchema,
    evaluate: ({ assertion, context }) => {
      if (
        !capsuleExpectationMatches(
          context,
          assertion.expectedPath,
          assertion.expectedValue,
        )
      ) {
        return fail(
          "observation_mismatch",
          "Capsule expectation does not match the mechanism assertion",
        );
      }
      const trigger = context.capsule.eventChain.find(
        (event) =>
          event.kind === "signal" &&
          event.source === assertion.signalSource &&
          event.name === assertion.signalName,
      );
      const failedDelivery = context.capsule.eventChain.find(
        (event) =>
          event.kind === "signal_delivery" &&
          event.source === assertion.signalSource &&
          event.name === assertion.signalName &&
          event.receiver === assertion.receiver &&
          !event.delivered &&
          event.failureReason === "receiver_not_connected" &&
          trigger !== undefined &&
          causallyDescendsFrom(
            event,
            trigger.eventId,
            context.capsule.eventChain,
          ),
      );
      const connected = context.capsule.eventChain.find(
        (event) =>
          event.kind === "property_changed" &&
          event.path === assertion.receiverConnectedPath &&
          event.after === true &&
          failedDelivery !== undefined &&
          event.seq > failedDelivery.seq,
      );
      if (
        trigger === undefined ||
        failedDelivery === undefined ||
        connected === undefined
      ) {
        return fail(
          "causal_chain_invalid",
          "Baseline lacks the asserted signal, failed delivery, and later receiver connection chain",
        );
      }
      for (const { comparison, candidate } of candidatePairs(context)) {
        if (
          comparison.intervention.kind !== "shift_input" ||
          comparison.intervention.inputOrder !== assertion.inputOrder ||
          comparison.intervention.deltaTicks < assertion.minimumDeltaTicks
        ) {
          continue;
        }
        const candidateTrigger = candidate.events.find(
          (event) =>
            event.kind === "signal" &&
            event.source === assertion.signalSource &&
            event.name === assertion.signalName,
        );
        const delivered = candidate.events.find(
          (event) =>
            event.kind === "signal_delivery" &&
            event.source === assertion.signalSource &&
            event.name === assertion.signalName &&
            event.receiver === assertion.receiver &&
            event.delivered &&
            candidateTrigger !== undefined &&
            causallyDescendsFrom(
              event,
              candidateTrigger.eventId,
              candidate.events,
            ),
        );
        const changed = candidate.events.find(
          (event) =>
            event.kind === "property_changed" &&
            event.path === assertion.expectedPath &&
            jsonEqual(event.after, assertion.expectedValue) &&
            delivered !== undefined &&
            causallyDescendsFrom(event, delivered.eventId, candidate.events),
        );
        if (
          candidateTrigger !== undefined &&
          delivered !== undefined &&
          changed !== undefined &&
          cited(context, [
            trigger,
            failedDelivery,
            connected,
            candidateTrigger,
            delivered,
            changed,
          ])
        ) {
          return supported();
        }
      }
      return fail(
        "intervention_evidence_missing",
        "No cited passing shift-input comparison establishes delivery and the expected state change",
        [trigger, failedDelivery, connected],
      );
    },
  });

export const createFrameWindowClaimEvidencePolicy =
  (): ClaimEvidencePolicy<FrameWindowAssertion> => ({
    descriptor: {
      policyId: "godot.frame-window-evidence",
      policyVersion: "1.0.0",
      mechanismId: GODOT_CLAIM_MECHANISM_IDS.frameWindow,
      assertionSchemaId: GODOT_CLAIM_ASSERTION_SCHEMA_IDS.frameWindow,
    },
    agentContract: {
      mechanismDescription:
        "A gameplay time window is advanced by process-frame callbacks, so frame-rate controls change whether an input is accepted inside that window.",
      evidenceRequirements: [
        "Cite the baseline property change that opens the gameplay window.",
        "Cite the baseline signal causally emitted after that window opens.",
        "Cite the baseline property change that closes the gameplay window.",
        "Cite the baseline input recorded after the window closes.",
        "Cite the candidate property change that opens the gameplay window.",
        "Cite the candidate input recorded while the gameplay window remains open.",
        "Cite the candidate property change to the asserted expected state caused by that input.",
      ],
      additionalProperties: false,
      assertionFields: [
        {
          name: "signalSource",
          type: "string",
          required: true,
          description: "Telemetry source that begins the gameplay window.",
        },
        {
          name: "signalName",
          type: "string",
          required: true,
          description: "Exact signal name that begins the gameplay window.",
        },
        {
          name: "windowPath",
          type: "string",
          required: true,
          description: "Observed property path representing window state.",
        },
        {
          name: "windowOpenValue",
          type: "json",
          required: true,
          description: "Value at windowPath that means the window is open.",
        },
        {
          name: "windowClosedValue",
          type: "json",
          required: true,
          description: "Value at windowPath that means the window is closed.",
        },
        {
          name: "processCallbacksPath",
          type: "string",
          required: true,
          description:
            "Observed counter path used to compare callbacks with realized process frames.",
        },
        {
          name: "inputAction",
          type: "string",
          required: true,
          description:
            "Input action whose acceptance is tested inside the window.",
        },
        {
          name: "expectedPath",
          type: "string",
          required: true,
          description: "Contract property path expected after accepted input.",
        },
        {
          name: "expectedValue",
          type: "json",
          required: true,
          description: "Contract value expected at expectedPath.",
        },
        {
          name: "baselineActualValue",
          type: "json",
          required: true,
          description: "Observed failing baseline value at expectedPath.",
        },
        {
          name: "runtimeControlName",
          type: "string",
          required: true,
          description:
            "Single runtime timing control changed by the intervention.",
          allowedValues: ["fixed_fps", "physics_ticks_per_second"],
        },
      ],
    },
    assertionSchema: FrameWindowAssertionSchema,
    evaluate: ({ assertion, context }) => {
      if (
        !capsuleExpectationMatches(
          context,
          assertion.expectedPath,
          assertion.expectedValue,
        ) ||
        !context.capsule.actual.present ||
        context.capsule.actual.value === undefined ||
        !jsonEqual(
          context.capsule.actual.value,
          assertion.baselineActualValue,
        ) ||
        !processFramesMatch(
          context.baselineExecution,
          assertion.processCallbacksPath,
        )
      ) {
        return fail(
          "observation_mismatch",
          "Baseline expectation, actual value, or realized frame count does not match the assertion",
        );
      }
      const opened = context.capsule.eventChain.find(
        (event) =>
          event.kind === "property_changed" &&
          event.path === assertion.windowPath &&
          jsonEqual(event.after, assertion.windowOpenValue),
      );
      const signal = context.capsule.eventChain.find(
        (event) =>
          event.kind === "signal" &&
          event.source === assertion.signalSource &&
          event.name === assertion.signalName &&
          opened !== undefined &&
          causallyDescendsFrom(
            event,
            opened.eventId,
            context.capsule.eventChain,
          ),
      );
      const closed = context.capsule.eventChain.find(
        (event) =>
          event.kind === "property_changed" &&
          event.path === assertion.windowPath &&
          jsonEqual(event.after, assertion.windowClosedValue) &&
          opened !== undefined &&
          event.seq > opened.seq,
      );
      const rejectedInput = context.capsule.eventChain.find(
        (event) =>
          event.kind === "input" &&
          event.action === assertion.inputAction &&
          closed !== undefined &&
          event.seq > closed.seq,
      );
      if (
        opened === undefined ||
        signal === undefined ||
        closed === undefined ||
        rejectedInput === undefined
      ) {
        return fail(
          "causal_chain_invalid",
          "Baseline lacks an opened window, asserted signal, closed window, then rejected input sequence",
        );
      }
      for (const { comparison, candidate } of candidatePairs(context)) {
        if (
          comparison.intervention.kind !== "set_runtime_control" ||
          comparison.intervention.name !== assertion.runtimeControlName ||
          !processFramesMatch(candidate, assertion.processCallbacksPath)
        ) {
          continue;
        }
        const candidateOpened = candidate.events.find(
          (event) =>
            event.kind === "property_changed" &&
            event.path === assertion.windowPath &&
            jsonEqual(event.after, assertion.windowOpenValue),
        );
        const acceptedInput = candidate.events.find(
          (event) =>
            event.kind === "input" &&
            event.action === assertion.inputAction &&
            candidateOpened !== undefined &&
            event.seq > candidateOpened.seq,
        );
        const candidateClosed = candidate.events.find(
          (event) =>
            event.kind === "property_changed" &&
            event.path === assertion.windowPath &&
            jsonEqual(event.after, assertion.windowClosedValue) &&
            candidateOpened !== undefined &&
            event.seq > candidateOpened.seq,
        );
        const changed = candidate.events.find(
          (event) =>
            event.kind === "property_changed" &&
            event.path === assertion.expectedPath &&
            jsonEqual(event.after, assertion.expectedValue) &&
            acceptedInput !== undefined &&
            causallyDescendsFrom(
              event,
              acceptedInput.eventId,
              candidate.events,
            ),
        );
        if (
          candidateOpened !== undefined &&
          acceptedInput !== undefined &&
          changed !== undefined &&
          (candidateClosed === undefined ||
            acceptedInput.seq < candidateClosed.seq) &&
          cited(context, [
            opened,
            signal,
            closed,
            rejectedInput,
            candidateOpened,
            acceptedInput,
            changed,
          ])
        ) {
          return supported();
        }
      }
      return fail(
        "intervention_evidence_missing",
        "No cited passing runtime-control comparison keeps the input inside the asserted window",
        [opened, signal, closed, rejectedInput],
      );
    },
  });

export const createPhysicsTunnelingClaimEvidencePolicy =
  (): ClaimEvidencePolicy<PhysicsTunnelingAssertion> => ({
    descriptor: {
      policyId: "godot.physics-tunneling-evidence",
      policyVersion: "1.0.0",
      mechanismId: GODOT_CLAIM_MECHANISM_IDS.physicsTunneling,
      assertionSchemaId: GODOT_CLAIM_ASSERTION_SCHEMA_IDS.physicsTunneling,
    },
    agentContract: {
      mechanismDescription:
        "Discrete physics steps move an entity across a target without recording a hit, while a single timing-control intervention produces the expected collision.",
      evidenceRequirements: [
        "Cite the baseline signal that triggers the movement under test.",
        "Cite the baseline property change that crosses the candidate collision position.",
        "Cite the baseline spatial sample recorded after that crossing movement.",
        "Cite the candidate signal that triggers movement after the timing intervention.",
        "Cite the candidate spatial sample associated with the successful collision.",
        "Cite the candidate property change to the asserted hit state.",
      ],
      additionalProperties: false,
      assertionFields: [
        {
          name: "signalSource",
          type: "string",
          required: true,
          description:
            "Telemetry source that triggers the movement under test.",
        },
        {
          name: "signalName",
          type: "string",
          required: true,
          description:
            "Exact signal name that triggers the movement under test.",
        },
        {
          name: "movingEntityStableId",
          type: "string",
          required: true,
          description: "Stable entity identity used by spatial samples.",
        },
        {
          name: "movementPath",
          type: "string",
          required: true,
          description:
            "Observed numeric property path whose before/after values cross the target.",
        },
        {
          name: "positionAxis",
          type: "integer",
          required: true,
          description: "Spatial sample axis used for the crossing comparison.",
          minimum: 0,
          allowedValues: [0, 1],
        },
        {
          name: "expectedPath",
          type: "string",
          required: true,
          description: "Contract property path representing a successful hit.",
        },
        {
          name: "expectedValue",
          type: "json",
          required: true,
          description: "Contract value expected at expectedPath.",
        },
        {
          name: "runtimeControlName",
          type: "string",
          required: true,
          description:
            "Single runtime timing control changed by the intervention.",
          allowedValues: ["fixed_fps", "physics_ticks_per_second"],
        },
      ],
    },
    assertionSchema: PhysicsTunnelingAssertionSchema,
    evaluate: ({ assertion, context }) => {
      if (
        !capsuleExpectationMatches(
          context,
          assertion.expectedPath,
          assertion.expectedValue,
        )
      ) {
        return fail(
          "observation_mismatch",
          "Capsule expectation does not match the mechanism assertion",
        );
      }
      const baselineSignal = context.capsule.eventChain.find(
        (event) =>
          event.kind === "signal" &&
          event.source === assertion.signalSource &&
          event.name === assertion.signalName,
      );
      if (baselineSignal === undefined) {
        return fail(
          "causal_chain_invalid",
          "Baseline lacks the asserted projectile trigger signal",
        );
      }
      for (const { comparison, candidate } of candidatePairs(context)) {
        if (
          comparison.intervention.kind !== "set_runtime_control" ||
          comparison.intervention.name !== assertion.runtimeControlName
        ) {
          continue;
        }
        const candidateSignal = candidate.events.find(
          (event) =>
            event.kind === "signal" &&
            event.source === assertion.signalSource &&
            event.name === assertion.signalName,
        );
        const hit = candidate.events.find(
          (event) =>
            event.kind === "property_changed" &&
            event.path === assertion.expectedPath &&
            jsonEqual(event.after, assertion.expectedValue),
        );
        if (candidateSignal === undefined || hit === undefined) continue;
        const hitSample = candidate.events.find(
          (event) =>
            event.kind === "spatial_sample" &&
            event.entity.stableId === assertion.movingEntityStableId &&
            causallyDescendsFrom(hit, event.eventId, candidate.events),
        );
        if (hitSample?.kind !== "spatial_sample") continue;
        const targetPosition = hitSample.position[assertion.positionAxis];
        const movement = context.capsule.eventChain.find((event) => {
          if (
            event.kind !== "property_changed" ||
            event.path !== assertion.movementPath ||
            typeof event.before !== "number" ||
            typeof event.after !== "number" ||
            !causallyDescendsFrom(
              event,
              baselineSignal.eventId,
              context.capsule.eventChain,
            )
          ) {
            return false;
          }
          const crossed =
            (event.before < targetPosition && event.after > targetPosition) ||
            (event.before > targetPosition && event.after < targetPosition);
          if (!crossed) return false;
          return context.capsule.eventChain.some(
            (sample) =>
              sample.kind === "spatial_sample" &&
              sample.entity.stableId === assertion.movingEntityStableId &&
              sample.causedByEventId === event.eventId &&
              sample.position[assertion.positionAxis] === event.after,
          );
        });
        if (movement?.kind !== "property_changed") continue;
        const movementSample = context.capsule.eventChain.find(
          (event) =>
            event.kind === "spatial_sample" &&
            event.entity.stableId === assertion.movingEntityStableId &&
            event.causedByEventId === movement.eventId &&
            event.position[assertion.positionAxis] === movement.after,
        );
        const baselineHit = context.capsule.eventChain.some(
          (event) =>
            event.kind === "property_changed" &&
            event.path === assertion.expectedPath &&
            jsonEqual(event.after, assertion.expectedValue),
        );
        if (
          movementSample !== undefined &&
          !baselineHit &&
          causallyDescendsFrom(
            hit,
            candidateSignal.eventId,
            candidate.events,
          ) &&
          cited(context, [
            baselineSignal,
            movement,
            movementSample,
            candidateSignal,
            hitSample,
            hit,
          ])
        ) {
          return supported();
        }
      }
      return fail(
        "intervention_evidence_missing",
        "No cited passing physics-control comparison connects a baseline crossing to a candidate hit",
        [baselineSignal],
      );
    },
  });

export const createEntityReuseClaimEvidencePolicy =
  (): ClaimEvidencePolicy<EntityReuseAssertion> => ({
    descriptor: {
      policyId: "godot.entity-reuse-evidence",
      policyVersion: "1.0.0",
      mechanismId: GODOT_CLAIM_MECHANISM_IDS.entityReuse,
      assertionSchemaId: GODOT_CLAIM_ASSERTION_SCHEMA_IDS.entityReuse,
    },
    agentContract: {
      mechanismDescription:
        "A deferred effect targets one entity incarnation but is later resolved onto a new incarnation that reused the same stable identity.",
      evidenceRequirements: [
        "Cite the baseline event that schedules the pending effect.",
        "Cite the baseline lifecycle event that despawns the effect's original target incarnation.",
        "Cite the baseline lifecycle event that spawns a replacement incarnation with the same stable identity.",
        "Cite the baseline event that applies the pending effect across the incarnation boundary.",
        "Cite the baseline property mutation caused by the cross-incarnation effect.",
        "Cite the baseline outcome signal caused after that mutation.",
        "Cite the candidate event that discards the stale pending effect.",
        "Cite the candidate outcome signal caused after that discard.",
      ],
      additionalProperties: false,
      assertionFields: [
        {
          name: "respawnSignalSource",
          type: "string",
          required: true,
          description: "Telemetry source that reports the respawn outcome.",
        },
        {
          name: "respawnSignalName",
          type: "string",
          required: true,
          description: "Exact signal name that reports the respawn outcome.",
        },
        {
          name: "entityStableId",
          type: "string",
          required: true,
          description:
            "Stable identity shared by the destroyed and replacement incarnations.",
        },
        {
          name: "mutationPath",
          type: "string",
          required: true,
          description:
            "Observed property path mutated by the cross-incarnation effect.",
        },
        {
          name: "expectedValue",
          type: "json",
          required: true,
          description: "Contract value expected at mutationPath.",
        },
        {
          name: "fixtureControlName",
          type: "string",
          required: true,
          description:
            "Single allowlisted fixture control changed by the intervention.",
        },
        {
          name: "fixtureControlValue",
          type: "json_primitive",
          required: true,
          description: "Primitive control value used by the intervention.",
        },
        {
          name: "discardReason",
          type: "string",
          required: true,
          description:
            "Candidate telemetry reason for safely discarding the stale effect.",
          allowedValues: [
            "owner_destroyed",
            "target_missing",
            "stale_incarnation",
          ],
        },
      ],
    },
    assertionSchema: EntityReuseAssertionSchema,
    evaluate: ({ assertion, context }) => {
      if (
        !capsuleExpectationMatches(
          context,
          assertion.mutationPath,
          assertion.expectedValue,
        )
      ) {
        return fail(
          "observation_mismatch",
          "Capsule expectation does not match the mechanism assertion",
        );
      }
      const scheduled = context.capsule.eventChain.find(
        (event) =>
          event.kind === "pending_effect" &&
          event.action === "scheduled" &&
          event.target.stableId === assertion.entityStableId,
      );
      if (scheduled?.kind !== "pending_effect") {
        return fail(
          "causal_chain_invalid",
          "Baseline lacks an asserted pending effect",
        );
      }
      const despawned = context.capsule.eventChain.find(
        (event) =>
          event.kind === "entity_lifecycle" &&
          event.action === "despawned" &&
          event.entity.stableId === assertion.entityStableId &&
          event.entity.incarnation === scheduled.target.incarnation &&
          causallyDescendsFrom(
            event,
            scheduled.eventId,
            context.capsule.eventChain,
          ),
      );
      if (despawned?.kind !== "entity_lifecycle") {
        return fail(
          "causal_chain_invalid",
          "The pending effect does not causally precede despawning its target incarnation",
          [scheduled],
        );
      }
      const spawned = context.capsule.eventChain.find(
        (event) =>
          event.kind === "entity_lifecycle" &&
          event.action === "spawned" &&
          event.entity.stableId === assertion.entityStableId &&
          event.entity.incarnation !== despawned.entity.incarnation &&
          causallyDescendsFrom(
            event,
            despawned.eventId,
            context.capsule.eventChain,
          ),
      );
      if (spawned?.kind !== "entity_lifecycle") {
        return fail(
          "causal_chain_invalid",
          "The target stable ID is not respawned with a new incarnation",
          [scheduled, despawned],
        );
      }
      const applied = context.capsule.eventChain.find(
        (event) =>
          event.kind === "pending_effect" &&
          event.action === "applied" &&
          event.effectId === scheduled.effectId &&
          event.target.stableId === assertion.entityStableId &&
          event.target.incarnation === scheduled.target.incarnation &&
          event.resolvedTarget?.stableId === assertion.entityStableId &&
          event.resolvedTarget.incarnation === spawned.entity.incarnation &&
          causallyDescendsFrom(
            event,
            spawned.eventId,
            context.capsule.eventChain,
          ),
      );
      if (applied?.kind !== "pending_effect") {
        return fail(
          "causal_chain_invalid",
          "The stale effect is not applied across the asserted incarnation boundary",
          [scheduled, despawned, spawned],
        );
      }
      const mutation = context.capsule.eventChain.find(
        (event) =>
          event.kind === "property_changed" &&
          event.path === assertion.mutationPath &&
          !jsonEqual(event.after, assertion.expectedValue) &&
          causallyDescendsFrom(
            event,
            applied.eventId,
            context.capsule.eventChain,
          ),
      );
      if (mutation?.kind !== "property_changed") {
        return fail(
          "causal_chain_invalid",
          "The stale effect does not cause the asserted state mutation",
          [scheduled, despawned, spawned, applied],
        );
      }
      const respawnSignal = context.capsule.eventChain.find(
        (event) =>
          event.kind === "signal" &&
          event.source === assertion.respawnSignalSource &&
          event.name === assertion.respawnSignalName &&
          causallyDescendsFrom(
            event,
            mutation.eventId,
            context.capsule.eventChain,
          ),
      );
      if (respawnSignal?.kind !== "signal") {
        return fail(
          "causal_chain_invalid",
          "The stale mutation does not causally precede the asserted respawn signal",
          [scheduled, despawned, spawned, applied, mutation],
        );
      }
      for (const { comparison, candidate } of candidatePairs(context)) {
        if (
          comparison.intervention.kind !== "set_fixture_control" ||
          comparison.intervention.name !== assertion.fixtureControlName ||
          !jsonEqual(
            comparison.intervention.value,
            assertion.fixtureControlValue,
          )
        ) {
          continue;
        }
        const discarded = candidate.events.find(
          (event) =>
            event.kind === "pending_effect" &&
            event.action === "discarded" &&
            event.effectId === scheduled.effectId &&
            event.target.stableId === assertion.entityStableId &&
            event.target.incarnation === scheduled.target.incarnation &&
            event.reason === assertion.discardReason,
        );
        if (discarded?.kind !== "pending_effect") continue;
        const candidateSignal = candidate.events.find(
          (event) =>
            event.kind === "signal" &&
            event.source === assertion.respawnSignalSource &&
            event.name === assertion.respawnSignalName &&
            causallyDescendsFrom(event, discarded.eventId, candidate.events),
        );
        if (
          candidateSignal?.kind === "signal" &&
          cited(context, [
            scheduled,
            despawned,
            spawned,
            applied,
            mutation,
            respawnSignal,
            discarded,
            candidateSignal,
          ])
        ) {
          return supported();
        }
      }
      return fail(
        "intervention_evidence_missing",
        "No cited passing fixture-control comparison discards the stale effect",
        [scheduled, despawned, spawned, applied, mutation, respawnSignal],
      );
    },
  });

export const createGodotClaimEvidencePolicyRegistry =
  (): ClaimEvidencePolicyRegistry =>
    new ClaimEvidencePolicyRegistry()
      .register(createSignalOrderingClaimEvidencePolicy())
      .register(createFrameWindowClaimEvidencePolicy())
      .register(createPhysicsTunnelingClaimEvidencePolicy())
      .register(createEntityReuseClaimEvidencePolicy());

export const V04_GODOT_CLAIM_ASSERTIONS = Object.freeze({
  signalOrdering: {
    schemaId: GODOT_CLAIM_ASSERTION_SCHEMA_IDS.signalOrdering,
    payload: {
      signalSource: "switch",
      signalName: "switch.activated",
      receiver: "door",
      receiverConnectedPath: "door.receiver_connected",
      expectedPath: "door.open",
      expectedValue: true,
      inputOrder: 0,
      minimumDeltaTicks: 1,
    },
  },
  frameWindow: {
    schemaId: GODOT_CLAIM_ASSERTION_SCHEMA_IDS.frameWindow,
    payload: {
      signalSource: "player",
      signalName: "player.left_ledge",
      windowPath: "player.window_open",
      windowOpenValue: true,
      windowClosedValue: false,
      processCallbacksPath: "player.process_callbacks",
      inputAction: "attempt_jump",
      expectedPath: "player.jumping",
      expectedValue: true,
      baselineActualValue: false,
      runtimeControlName: "fixed_fps",
    },
  },
  physicsTunneling: {
    schemaId: GODOT_CLAIM_ASSERTION_SCHEMA_IDS.physicsTunneling,
    payload: {
      signalSource: "projectile",
      signalName: "projectile.fired",
      movingEntityStableId: "projectile",
      movementPath: "projectile.x",
      positionAxis: 0,
      expectedPath: "target.hit",
      expectedValue: true,
      runtimeControlName: "physics_ticks_per_second",
    },
  },
  entityReuse: {
    schemaId: GODOT_CLAIM_ASSERTION_SCHEMA_IDS.entityReuse,
    payload: {
      respawnSignalSource: "enemy",
      respawnSignalName: "enemy.respawned",
      entityStableId: "enemy",
      mutationPath: "enemy.health",
      expectedValue: 100,
      fixtureControlName: "pooling_enabled",
      fixtureControlValue: false,
      discardReason: "owner_destroyed",
    },
  },
} satisfies Readonly<
  Record<string, { readonly schemaId: string; readonly payload: JsonObject }>
>);

export interface V04GodotFixtureClaim {
  readonly kind: "mechanism";
  readonly mechanismId: string;
  readonly assertion: {
    readonly schemaId: string;
    readonly payload: JsonObject;
  };
}

const fixtureClaimTemplates: Readonly<
  Record<
    V03FixtureName,
    {
      readonly mechanismId: string;
      readonly assertion: {
        readonly schemaId: string;
        readonly payload: JsonObject;
      };
    }
  >
> = Object.freeze({
  "signal-ordering": {
    mechanismId: GODOT_CLAIM_MECHANISM_IDS.signalOrdering,
    assertion: V04_GODOT_CLAIM_ASSERTIONS.signalOrdering,
  },
  "frame-input-window": {
    mechanismId: GODOT_CLAIM_MECHANISM_IDS.frameWindow,
    assertion: V04_GODOT_CLAIM_ASSERTIONS.frameWindow,
  },
  "physics-tunneling": {
    mechanismId: GODOT_CLAIM_MECHANISM_IDS.physicsTunneling,
    assertion: V04_GODOT_CLAIM_ASSERTIONS.physicsTunneling,
  },
  "entity-reuse": {
    mechanismId: GODOT_CLAIM_MECHANISM_IDS.entityReuse,
    assertion: V04_GODOT_CLAIM_ASSERTIONS.entityReuse,
  },
});

/**
 * Demo/test composition helper. The live Conclusion Gate selects policies only
 * through its registry and never reads this Fixture-to-claim mapping.
 */
export const v04GodotClaimForFixture = (
  fixtureName: V03FixtureName,
): V04GodotFixtureClaim => {
  const template = fixtureClaimTemplates[fixtureName];
  return {
    kind: "mechanism",
    mechanismId: template.mechanismId,
    assertion: {
      schemaId: template.assertion.schemaId,
      payload: structuredClone(template.assertion.payload),
    },
  };
};

export const citedEventIdsFor = (
  ...events: readonly V03TelemetryEvent[]
): readonly EventId[] => events.map((event) => event.eventId);
