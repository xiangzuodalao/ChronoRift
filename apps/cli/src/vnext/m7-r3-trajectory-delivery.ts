import {
  validateProjectEnvironmentGameToolInputV1,
  validateProjectEnvironmentGameToolOutputV1,
  type ProjectEnvironmentGameQueryInputV1,
  type ProjectEnvironmentGameQueryOutputV1,
} from "@chronorift/agent-protocol";
import {
  JsonValueSchema,
  Sha256DigestV1Schema,
  asSha256DigestV1,
  type JsonValue,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson, contentHash } from "@chronorift/json-artifacts";
import { z } from "zod";

import type { M7AgentGameToolExchangeV1 } from "./m7-project-environment-paired-agent.js";
import {
  M7PatrolEntityStateV1Schema,
  M7PatrolStateTimelineV1Schema,
  type M7PatrolStateTimelineV1,
} from "./m7-patrol-sensor.js";
import {
  M7PatrolTrajectoryClassificationV1Schema,
  M7PatrolTrajectoryClassifierConfigV1Schema,
  M7PatrolTrajectoryWitnessKindV1Schema,
  M7R3AgentVisibleFinalToolResultV1Schema,
  classifyM7PatrolTrajectoryV1,
  type M7PatrolTrajectoryClassificationV1,
  type M7PatrolTrajectoryClassifierConfigV1,
  type M7PatrolTrajectoryWitnessKindV1,
  type M7R3AgentVisibleFinalToolResultV1,
} from "./m7-patrol-trajectory.js";
import {
  M7R3AgentDeliveryTraceV1Schema,
  type M7R3AgentDeliveryTraceV1,
  type M7R3AgentToolDeliveryRecordV1,
} from "./m7-r3-agent-delivery.js";

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

const hashJson = (value: unknown): Sha256DigestV1 =>
  asSha256DigestV1(contentHash(JsonValueSchema.parse(value)));

const prefixBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    executionId: opaqueIdSchema,
    timeline: M7PatrolStateTimelineV1Schema,
    classification: M7PatrolTrajectoryClassificationV1Schema,
    expectedWitnessKinds: z
      .array(M7PatrolTrajectoryWitnessKindV1Schema)
      .min(1)
      .max(5),
    agentVisibleAtHostToolReturnOrdinal: positiveSafeIntegerSchema,
    agentVisibleExchangeTranscriptSha256: Sha256DigestV1Schema,
    agentVisibleExchangeReceiptSha256: Sha256DigestV1Schema,
    agentVisibleDeliveryResponseSha256: Sha256DigestV1Schema,
    agentVisibleResponseDetailsSha256: Sha256DigestV1Schema,
    agentVisibleFinalToolResult: M7R3AgentVisibleFinalToolResultV1Schema,
  })
  .strict();

export const M7R3AgentVisibleTrajectoryPrefixV1Schema = prefixBasisSchema
  .extend({ prefixContentSha256: Sha256DigestV1Schema })
  .strict()
  .superRefine((value, context) => {
    if (value.timeline.execution_id !== value.executionId) {
      context.addIssue({
        code: "custom",
        path: ["timeline", "execution_id"],
        message: "R3 visible trajectory prefix crossed its execution",
      });
    }
    const availableKinds = new Set(
      value.classification.witnesses
        .filter((witness) => !witness.fallOffEdge)
        .map((witness) => witness.kind),
    );
    if (!value.expectedWitnessKinds.every((kind) => availableKinds.has(kind))) {
      context.addIssue({
        code: "custom",
        path: ["expectedWitnessKinds"],
        message: "R3 visible prefix omitted an expected generic witness",
      });
    }
    if (
      value.agentVisibleAtHostToolReturnOrdinal !==
        value.agentVisibleFinalToolResult.hostToolReturnOrdinal ||
      value.agentVisibleDeliveryResponseSha256 !==
        value.agentVisibleFinalToolResult.finalResultSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["agentVisibleFinalToolResult"],
        message: "R3 visible prefix crossed its final Pi ToolResult",
      });
    }
    const { prefixContentSha256, ...basis } = value;
    if (prefixContentSha256 !== hashJson(basis)) {
      context.addIssue({
        code: "custom",
        path: ["prefixContentSha256"],
        message: "R3 visible trajectory prefix hash does not match",
      });
    }
  });
export type M7R3AgentVisibleTrajectoryPrefixV1 = z.infer<
  typeof M7R3AgentVisibleTrajectoryPrefixV1Schema
>;

const asRecord = (
  value: JsonValue,
): Readonly<Record<string, JsonValue>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;

interface RetainedStateSample {
  readonly recordSequence: number;
  readonly entities: z.infer<typeof M7PatrolEntityStateV1Schema>[];
  readonly canonical: string;
}

const successEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    toolCallId: opaqueIdSchema,
    outcome: z.literal("success"),
    output: JsonValueSchema,
  })
  .strict();

interface ParsedQueryExchange {
  readonly taskId: string;
  readonly executionId: string;
  readonly rows: ProjectEnvironmentGameQueryOutputV1["rows"];
}

/**
 * Parses the actual Project Environment query envelope. A query for another
 * execution is irrelevant, but an input/response identity disagreement is
 * corrupt evidence and must not be silently filtered away.
 */
const parseQueryExchange = (
  exchange: M7AgentGameToolExchangeV1,
  expectedExecutionId: string,
): ParsedQueryExchange | null => {
  if (exchange.toolName !== "game_query") return null;
  if (
    !validateProjectEnvironmentGameToolInputV1("game_query", exchange.input)
  ) {
    throw new TypeError("R3 Agent-visible game_query input is invalid");
  }
  const queryInput = exchange.input as ProjectEnvironmentGameQueryInputV1;
  const response = asRecord(exchange.response);
  if (
    response === null ||
    response.schemaVersion !== 1 ||
    response.toolCallId !== exchange.toolCallId
  ) {
    throw new TypeError(
      "R3 Agent-visible game_query response crossed its Pi tool call",
    );
  }
  if (response.outcome === "error") return null;
  const envelope = successEnvelopeSchema.safeParse(exchange.response);
  if (
    !envelope.success ||
    !validateProjectEnvironmentGameToolOutputV1(
      "game_query",
      envelope.data.output,
    )
  ) {
    throw new TypeError(
      "R3 Agent-visible game_query response is not a real PE success envelope",
    );
  }
  const output = envelope.data.output as ProjectEnvironmentGameQueryOutputV1;
  if (
    queryInput.taskId !== output.taskId ||
    queryInput.executionId !== output.executionId
  ) {
    throw new TypeError(
      "R3 Agent-visible game_query input/response task or execution crossed",
    );
  }
  if (output.executionId !== expectedExecutionId) return null;
  if (queryInput.select !== "state") return null;
  return {
    taskId: output.taskId,
    executionId: output.executionId,
    rows: output.rows,
  };
};

const collectStateSamples = (
  queries: readonly ParsedQueryExchange[],
): readonly RetainedStateSample[] => {
  const samples = new Map<number, RetainedStateSample>();
  for (const query of queries) {
    for (const row of query.rows) {
      if (row.kind !== "state") continue;
      const record = asRecord(JsonValueSchema.parse(row.value));
      if (record === null) continue;
      const payload = asRecord(record.payload ?? null);
      const state = asRecord(payload?.value ?? null);
      if (
        record.kind === "state_sample" &&
        payload?.stateDomainId === "patrol.motion" &&
        payload.semanticCoverage === "declared" &&
        Number.isSafeInteger(record.recordSequence) &&
        typeof record.recordSequence === "number" &&
        record.recordSequence >= 0 &&
        Array.isArray(state?.agents)
      ) {
        const entities = state.agents.map((entry) =>
          M7PatrolEntityStateV1Schema.parse(entry),
        );
        if (entities.length > 0) {
          const canonical = canonicalJson(
            JsonValueSchema.parse({
              recordSequence: record.recordSequence,
              entities,
            }),
          );
          const prior = samples.get(record.recordSequence);
          if (prior !== undefined && prior.canonical !== canonical) {
            throw new TypeError(
              "R3 Agent-visible state sequence carried conflicting payloads",
            );
          }
          samples.set(record.recordSequence, {
            recordSequence: record.recordSequence,
            entities,
            canonical,
          });
          if (samples.size > 100_000) {
            throw new Error(
              "R3 Agent-visible trajectory sample budget exhausted",
            );
          }
        }
      }
    }
  }
  return [...samples.values()].sort(
    (left, right) => left.recordSequence - right.recordSequence,
  );
};

export const createM7R3PatrolTimelineFromAgentVisibleResponsesV1 = (input: {
  readonly executionId: string;
  readonly exchanges: readonly M7AgentGameToolExchangeV1[];
}): M7PatrolStateTimelineV1 | null => {
  const executionId = opaqueIdSchema.parse(input.executionId);
  const queries = input.exchanges.flatMap((exchange) => {
    const parsed = parseQueryExchange(exchange, executionId);
    return parsed === null ? [] : [parsed];
  });
  if (new Set(queries.map((query) => query.taskId)).size > 1) {
    throw new TypeError(
      "R3 Agent-visible trajectory queries crossed their PE Task identity",
    );
  }
  const samples = collectStateSamples(queries);
  if (samples.length < 2) return null;
  return M7PatrolStateTimelineV1Schema.parse({
    schemaVersion: 1,
    execution_id: executionId,
    frames: samples.map((sample) => ({
      sample_ordinal: sample.recordSequence,
      entities: sample.entities,
    })),
  });
};

const visibleFinalResult = (
  delivery: M7R3AgentToolDeliveryRecordV1,
): M7R3AgentVisibleFinalToolResultV1 | null => {
  if (
    delivery.toolKind !== "game" ||
    !delivery.finalResultMatched ||
    delivery.finalResultDetailsSha256 === null ||
    delivery.piEventOrdinal === null ||
    delivery.eventReceiptSha256 === null ||
    delivery.availableToModelAtAgentTurnOrdinal === null ||
    delivery.modelAvailabilityReceiptSha256 === null
  ) {
    return null;
  }
  return M7R3AgentVisibleFinalToolResultV1Schema.parse({
    schemaVersion: 1,
    eventType: "tool_execution_end",
    resultProjectionKind: delivery.resultProjectionKind,
    piEventOrdinal: delivery.piEventOrdinal,
    toolResultProducedInAgentTurnOrdinal:
      delivery.toolResultProducedInAgentTurnOrdinal,
    availableToModelAtAgentTurnOrdinal:
      delivery.availableToModelAtAgentTurnOrdinal,
    toolCallId: delivery.toolCallId,
    toolName: delivery.toolName,
    hostToolReturnOrdinal: delivery.hostToolReturnOrdinal,
    finalResultSha256: delivery.finalResultSha256,
    finalResultDetailsSha256: delivery.finalResultDetailsSha256,
    eventReceiptSha256: delivery.eventReceiptSha256,
    modelAvailabilityReceiptSha256: delivery.modelAvailabilityReceiptSha256,
  });
};

/**
 * Selects the earliest prefix that the model had actually received and that
 * contains every generic witness required by the Host-only case spec. The
 * function never looks at backend captures or later hidden-evaluator output.
 */
export const classifyM7R3EarliestAgentVisibleTrajectoryPrefixV1 = (input: {
  readonly executionId: string;
  readonly exchanges: readonly M7AgentGameToolExchangeV1[];
  readonly deliveryTrace: M7R3AgentDeliveryTraceV1;
  readonly expectedWitnessKinds: readonly M7PatrolTrajectoryWitnessKindV1[];
  readonly classifierConfig: M7PatrolTrajectoryClassifierConfigV1;
}): M7R3AgentVisibleTrajectoryPrefixV1 | null => {
  const trace = M7R3AgentDeliveryTraceV1Schema.parse(input.deliveryTrace);
  if (trace.integrityFailures.length > 0) return null;
  const expectedWitnessKinds = z
    .array(M7PatrolTrajectoryWitnessKindV1Schema)
    .min(1)
    .max(5)
    .parse(input.expectedWitnessKinds);
  if (new Set(expectedWitnessKinds).size !== expectedWitnessKinds.length) {
    throw new TypeError("R3 expected trajectory witness kinds must be unique");
  }
  const classifierConfig = M7PatrolTrajectoryClassifierConfigV1Schema.parse(
    input.classifierConfig,
  );
  const exchangeByCall = new Map(
    input.exchanges.map((exchange) => [exchange.toolCallId, exchange] as const),
  );
  if (exchangeByCall.size !== input.exchanges.length) {
    throw new TypeError(
      "R3 Agent-visible game exchanges must have unique calls",
    );
  }
  const visible = trace.deliveries
    .map((delivery) => {
      const finalResult = visibleFinalResult(delivery);
      const exchange = exchangeByCall.get(delivery.toolCallId);
      if (
        finalResult === null ||
        exchange === undefined ||
        exchange.hostToolReturnOrdinal !== delivery.hostToolReturnOrdinal ||
        exchange.toolName !== delivery.toolName
      ) {
        return null;
      }
      if (
        delivery.toolArgumentsSha256 !== hashJson(exchange.input) ||
        delivery.finalResultDetailsSha256 === null ||
        delivery.finalResultDetailsSha256 !== hashJson(exchange.response)
      ) {
        throw new TypeError(
          "R3 raw game exchange was substituted after Pi ToolResult delivery",
        );
      }
      const query = parseQueryExchange(exchange, input.executionId);
      if (query === null) return null;
      return { delivery, finalResult, exchange, query };
    })
    .filter((entry) => entry !== null)
    .sort(
      (left, right) =>
        left.finalResult.availableToModelAtAgentTurnOrdinal -
          right.finalResult.availableToModelAtAgentTurnOrdinal ||
        left.finalResult.piEventOrdinal - right.finalResult.piEventOrdinal,
    );
  if (new Set(visible.map((entry) => entry.query.taskId)).size > 1) {
    throw new TypeError(
      "R3 visible trajectory prefix crossed its PE Task identity",
    );
  }
  for (const candidate of visible) {
    const prefix = visible
      .filter(
        (entry) =>
          entry.finalResult.availableToModelAtAgentTurnOrdinal <=
          candidate.finalResult.availableToModelAtAgentTurnOrdinal,
      )
      .sort(
        (left, right) =>
          left.exchange.hostToolReturnOrdinal -
          right.exchange.hostToolReturnOrdinal,
      );
    const boundary = prefix.at(-1);
    if (boundary === undefined) continue;
    const timeline = createM7R3PatrolTimelineFromAgentVisibleResponsesV1({
      executionId: input.executionId,
      exchanges: prefix.map((entry) => entry.exchange),
    });
    if (timeline === null) continue;
    const classification: M7PatrolTrajectoryClassificationV1 =
      classifyM7PatrolTrajectoryV1({ timeline, config: classifierConfig });
    const kinds = new Set(
      classification.witnesses
        .filter((witness) => !witness.fallOffEdge)
        .map((witness) => witness.kind),
    );
    if (!expectedWitnessKinds.every((kind) => kinds.has(kind))) continue;
    const transcript = prefix.map(({ exchange }) =>
      JsonValueSchema.parse(exchange),
    );
    const receiptProjection = prefix.map(({ delivery }) =>
      JsonValueSchema.parse(delivery),
    );
    const basis = prefixBasisSchema.parse({
      schemaVersion: 1,
      executionId: input.executionId,
      timeline,
      classification,
      expectedWitnessKinds,
      agentVisibleAtHostToolReturnOrdinal:
        boundary.finalResult.hostToolReturnOrdinal,
      agentVisibleExchangeTranscriptSha256: hashJson(transcript),
      agentVisibleExchangeReceiptSha256: hashJson(receiptProjection),
      agentVisibleDeliveryResponseSha256:
        boundary.finalResult.finalResultSha256,
      agentVisibleResponseDetailsSha256:
        boundary.delivery.finalResultDetailsSha256,
      agentVisibleFinalToolResult: boundary.finalResult,
    });
    return M7R3AgentVisibleTrajectoryPrefixV1Schema.parse({
      ...basis,
      prefixContentSha256: hashJson(basis),
    });
  }
  return null;
};
