import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type FauxProviderHandle,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";

const FAUX_TIMESTAMP = 1_735_689_600_000;
export const DETERMINISTIC_PI_PROVIDER = "chronorift-faux";
export const DETERMINISTIC_PI_MODEL = "switch-door-v0.1";

type UnknownRecord = Record<string, unknown>;

function expectRecord(value: unknown, label: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as UnknownRecord;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is not a non-empty string`);
  }
  return value;
}

function recordArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.flatMap((entry) =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry)
          ? [entry as UnknownRecord]
          : [],
      )
    : [];
}

function eventById(
  events: readonly UnknownRecord[],
  eventId: unknown,
): UnknownRecord | undefined {
  return typeof eventId === "string"
    ? events.find((event) => event["eventId"] === eventId)
    : undefined;
}

function eventPrecedes(earlier: UnknownRecord, later: UnknownRecord): boolean {
  const earlierTick = earlier["tick"];
  const laterTick = later["tick"];
  const earlierSeq = earlier["seq"];
  const laterSeq = later["seq"];
  return (
    typeof earlierTick === "number" &&
    typeof laterTick === "number" &&
    typeof earlierSeq === "number" &&
    typeof laterSeq === "number" &&
    (earlierTick < laterTick ||
      (earlierTick === laterTick && earlierSeq < laterSeq))
  );
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function latestToolJson(context: Context, toolName: string): UnknownRecord {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message?.role !== "toolResult" || message.toolName !== toolName) {
      continue;
    }
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    try {
      return expectRecord(JSON.parse(text) as unknown, `${toolName} result`);
    } catch (error) {
      throw new Error(`Could not parse ${toolName} result`, { cause: error });
    }
  }
  throw new Error(`Missing tool result for ${toolName}`);
}

function toolResponse(
  step: number,
  name: string,
  arguments_: UnknownRecord,
): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage(
    fauxToolCall(name, arguments_, {
      id: `chronorift-faux-call-${String(step).padStart(2, "0")}`,
    }),
    { stopReason: "toolUse", timestamp: FAUX_TIMESTAMP + step },
  );
}

function scriptedResponses(initialCapsuleId: string): FauxResponseStep[] {
  return [
    toolResponse(1, "game_get_evidence_capsule", {
      capsuleId: initialCapsuleId,
    }),
    (context) => {
      const capsule = latestToolJson(context, "game_get_evidence_capsule");
      return toolResponse(2, "game_replay_execution", {
        executionId: expectString(
          capsule["baselineExecutionId"],
          "capsule.baselineExecutionId",
        ),
      });
    },
    (context) => {
      const capsule = latestToolJson(context, "game_get_evidence_capsule");
      latestToolJson(context, "game_replay_execution");
      return toolResponse(3, "game_run_intervention", {
        baselineExecutionId: expectString(
          capsule["baselineExecutionId"],
          "capsule.baselineExecutionId",
        ),
        deltaTicks: 1,
      });
    },
    (context) => {
      const replay = latestToolJson(context, "game_replay_execution");
      const intervention = latestToolJson(context, "game_run_intervention");
      const replayExecution = expectRecord(
        replay["execution"],
        "replay.execution",
      );
      const candidateExecution = expectRecord(
        intervention["execution"],
        "intervention.execution",
      );
      return toolResponse(4, "game_compare_executions", {
        baselineExecutionId: expectString(
          replayExecution["executionId"],
          "replay.execution.executionId",
        ),
        candidateExecutionId: expectString(
          candidateExecution["executionId"],
          "intervention.execution.executionId",
        ),
      });
    },
    (context) => {
      const capsule = latestToolJson(context, "game_get_evidence_capsule");
      const replay = latestToolJson(context, "game_replay_execution");
      const intervention = latestToolJson(context, "game_run_intervention");
      const comparison = latestToolJson(context, "game_compare_executions");
      const replayExecution = expectRecord(
        replay["execution"],
        "replay.execution",
      );
      const candidateExecution = expectRecord(
        intervention["execution"],
        "intervention.execution",
      );
      const capsuleId = expectString(capsule["capsuleId"], "capsule.capsuleId");
      const replayExecutionId = expectString(
        replayExecution["executionId"],
        "replay.execution.executionId",
      );
      const candidateExecutionId = expectString(
        candidateExecution["executionId"],
        "intervention.execution.executionId",
      );
      const comparisonId = expectString(
        comparison["comparisonId"],
        "comparison.comparisonId",
      );
      const capsuleEvents = recordArray(capsule["eventChain"]);
      const candidateEvents = recordArray(candidateExecution["events"]);
      const trigger = eventById(capsuleEvents, capsule["triggerEventId"]);
      const failedDelivery = eventById(
        capsuleEvents,
        capsule["signalDeliveryEventId"],
      );
      const receiverConnection = eventById(
        capsuleEvents,
        capsule["receiverConnectedEventId"],
      );
      const expectedEffect =
        capsule["expected"] !== null &&
        typeof capsule["expected"] === "object" &&
        !Array.isArray(capsule["expected"])
          ? (capsule["expected"] as UnknownRecord)
          : undefined;
      const comparisonIntervention =
        comparison["intervention"] !== null &&
        typeof comparison["intervention"] === "object" &&
        !Array.isArray(comparison["intervention"])
          ? (comparison["intervention"] as UnknownRecord)
          : undefined;
      const signalSource = trigger?.["source"];
      const signalName = trigger?.["name"];
      const receiver = failedDelivery?.["receiver"];
      const failureReason = failedDelivery?.["failureReason"];
      const mechanismCode =
        failureReason === "receiver_not_connected"
          ? "signal_before_receiver_connection"
          : undefined;
      const expectedPath = expectedEffect?.["path"];
      const expectedValue = expectedEffect?.["value"];
      const receiverConnectionPath =
        typeof receiver === "string"
          ? `${receiver}.receiver_connected`
          : undefined;
      const candidateSignal = candidateEvents.find(
        (event) =>
          event["kind"] === "signal" &&
          event["source"] === signalSource &&
          event["name"] === signalName,
      );
      const candidateDelivery = candidateEvents.find(
        (event) =>
          event["kind"] === "signal_delivery" &&
          event["delivered"] === true &&
          event["receiver"] === receiver &&
          event["causedByEventId"] === candidateSignal?.["eventId"],
      );
      const candidateEffect = candidateEvents.find(
        (event) =>
          event["kind"] === "property_changed" &&
          event["path"] === expectedPath &&
          jsonValuesEqual(event["after"], expectedValue) &&
          event["causedByEventId"] === candidateDelivery?.["eventId"],
      );
      const candidateReceiverConnection = candidateEvents.find(
        (event) =>
          event["kind"] === "property_changed" &&
          event["path"] === receiverConnectionPath &&
          event["before"] === false &&
          event["after"] === true,
      );
      const orderingMatchesReason =
        failedDelivery !== undefined &&
        receiverConnection !== undefined &&
        failureReason === "receiver_not_connected" &&
        receiverConnection["kind"] === "property_changed" &&
        receiverConnection["path"] === receiverConnectionPath &&
        receiverConnection["before"] === false &&
        receiverConnection["after"] === true &&
        eventPrecedes(failedDelivery, receiverConnection);
      const candidateOrderingSupportsMechanism =
        candidateReceiverConnection !== undefined &&
        candidateSignal !== undefined &&
        eventPrecedes(candidateReceiverConnection, candidateSignal);
      const sufficient =
        replay["matches"] === true &&
        comparison["comparable"] === true &&
        comparison["baselineOutcome"] === "fail" &&
        comparison["candidateOutcome"] === "pass" &&
        trigger?.["kind"] === "signal" &&
        typeof signalSource === "string" &&
        typeof signalName === "string" &&
        failedDelivery?.["kind"] === "signal_delivery" &&
        failedDelivery["delivered"] === false &&
        failedDelivery["causedByEventId"] === trigger["eventId"] &&
        failedDelivery["source"] === signalSource &&
        failedDelivery["name"] === signalName &&
        typeof receiver === "string" &&
        mechanismCode !== undefined &&
        orderingMatchesReason &&
        expectedEffect?.["kind"] === "property_equals" &&
        typeof expectedPath === "string" &&
        comparisonIntervention?.["kind"] === "delay_input" &&
        comparisonIntervention["deltaTicks"] === 1 &&
        candidateSignal !== undefined &&
        candidateOrderingSupportsMechanism &&
        candidateDelivery !== undefined &&
        candidateEffect !== undefined;

      const evidenceReferences: UnknownRecord[] = [
        { artifactKind: "capsule", capsuleId },
        {
          artifactKind: "execution",
          executionId: expectString(
            capsule["baselineExecutionId"],
            "capsule.baselineExecutionId",
          ),
        },
      ];
      if (typeof failedDelivery?.["eventId"] === "string") {
        evidenceReferences.push({
          artifactKind: "event",
          eventId: failedDelivery["eventId"],
        });
      }

      const common = {
        schemaVersion: 1,
        proposalId: `proposal:${capsuleId}`,
        runId: expectString(capsule["runId"], "capsule.runId"),
        capsuleId,
        baselineExecutionId: expectString(
          capsule["baselineExecutionId"],
          "capsule.baselineExecutionId",
        ),
        replayExecutionId,
        candidateExecutionId,
        comparisonId,
        observedFacts: [
          {
            statement: `The baseline emitted ${String(signalName)} from ${String(signalSource)} and recorded failed delivery to ${String(receiver)}.`,
            references: evidenceReferences,
          },
          {
            statement:
              "The isolated one-tick input delay changed the Contract outcome in the comparison.",
            references: [
              { artifactKind: "execution", executionId: replayExecutionId },
              {
                artifactKind: "execution",
                executionId: candidateExecutionId,
              },
              { artifactKind: "comparison", comparisonId },
            ],
          },
        ],
        attemptedActions: [
          "Read the Evidence Capsule",
          "Replayed the baseline execution",
          "Ran the one-tick input-delay intervention",
          "Compared the replay and intervention executions",
        ],
        confidence: sufficient ? 0 : 1,
      } as const;

      const proposal = sufficient
        ? {
            ...common,
            claim: {
              kind: "mechanism",
              summary:
                "The switch activation occurs before the door receiver is connected.",
              mechanism:
                "The emitted Signal is not delivered or replayed after the receiver connects, so the door remains closed.",
              category: "signal_ordering",
              mechanismCode,
              assertion: {
                signal: {
                  kind: "signal",
                  source: signalSource,
                  name: signalName,
                },
                receiver,
                failedDeliveryReason: failureReason,
                expectedEffect: {
                  kind: "property_equals",
                  path: expectedPath,
                  value: expectedValue,
                },
                intervention: {
                  kind: comparisonIntervention?.["kind"],
                  deltaTicks: comparisonIntervention?.["deltaTicks"],
                },
              },
            },
            hypotheses: [
              "Delaying the only interaction lets receiver initialization complete before Signal emission.",
            ],
            unknowns: [],
            blockers: [],
            nextExperiment: null,
          }
        : {
            ...common,
            claim: {
              kind: "unknown",
              summary:
                "The available replay and comparison do not meet the minimum mechanism-evidence threshold.",
            },
            hypotheses: [],
            unknowns: [
              "Whether the observed outcome change is reproducible under a matching replay.",
            ],
            blockers: [
              "Replay or comparison quality is insufficient for a mechanism claim.",
            ],
            nextExperiment:
              "Restore the same checkpoint and repeat the baseline replay before rerunning the one-tick intervention.",
          };

      return toolResponse(5, "submit_diagnosis_proposal", proposal);
    },
  ];
}

export function createDeterministicFauxProvider(
  initialCapsuleId: string,
): FauxProviderHandle {
  const faux = fauxProvider({
    api: "chronorift-faux-v0.1",
    provider: DETERMINISTIC_PI_PROVIDER,
    models: [
      {
        id: DETERMINISTIC_PI_MODEL,
        name: "ChronoRift deterministic switch-door model",
        reasoning: false,
        input: ["text"],
        contextWindow: 32_768,
        maxTokens: 4_096,
      },
    ],
    tokenSize: { min: 4, max: 4 },
  });
  faux.setResponses(scriptedResponses(initialCapsuleId));
  return faux;
}
