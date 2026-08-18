import {
  JsonValueSchema,
  Sha256DigestV1Schema,
  asSha256DigestV1,
  type JsonValue,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson, contentHash } from "@chronorift/json-artifacts";
import { z } from "zod";

import {
  M7R3AgentVisibleFinalToolResultV1Schema,
  M7R3HostObservedSourceChangeBoundaryV1Schema,
  type M7R3AgentVisibleFinalToolResultV1,
  type M7R3HostObservedSourceChangeBoundaryV1,
} from "./m7-patrol-trajectory.js";

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

const hashJson = (value: unknown): Sha256DigestV1 =>
  asSha256DigestV1(contentHash(JsonValueSchema.parse(value)));

const deliveryRecordBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    resultProjectionKind: z.literal("json-roundtrip-v1"),
    toolCallId: opaqueIdSchema,
    toolName: toolNameSchema,
    toolKind: z.enum(["game", "coding"]),
    toolArgumentsSha256: Sha256DigestV1Schema,
    toolResultProducedInAgentTurnOrdinal: positiveSafeIntegerSchema,
    hostToolReturnOrdinal: positiveSafeIntegerSchema,
    finalResultSha256: Sha256DigestV1Schema,
    finalResultDetailsSha256: Sha256DigestV1Schema.nullable(),
    piEventOrdinal: positiveSafeIntegerSchema.nullable(),
    eventResultSha256: Sha256DigestV1Schema.nullable(),
    eventResultDetailsSha256: Sha256DigestV1Schema.nullable(),
    finalResultMatched: z.boolean(),
    availableToModelAtAgentTurnOrdinal: positiveSafeIntegerSchema.nullable(),
    eventReceiptSha256: Sha256DigestV1Schema.nullable(),
    modelAvailabilityReceiptSha256: Sha256DigestV1Schema.nullable(),
  })
  .strict();

export const M7R3AgentToolDeliveryRecordV1Schema = deliveryRecordBasisSchema
  .extend({ recordContentSha256: Sha256DigestV1Schema })
  .strict()
  .superRefine((value, context) => {
    const finalized =
      value.piEventOrdinal !== null &&
      value.eventResultSha256 !== null &&
      value.eventReceiptSha256 !== null;
    const detailsMatched =
      value.eventResultDetailsSha256 === value.finalResultDetailsSha256;
    if (
      finalized !== value.finalResultMatched ||
      value.finalResultMatched !==
        (value.eventResultSha256 === value.finalResultSha256 && detailsMatched)
    ) {
      context.addIssue({
        code: "custom",
        path: ["finalResultMatched"],
        message: "R3 final ToolResult match facts disagree",
      });
    }
    if (value.toolKind === "game" && value.finalResultDetailsSha256 === null) {
      context.addIssue({
        code: "custom",
        path: ["finalResultDetailsSha256"],
        message: "an R3 game ToolResult must retain its exact details hash",
      });
    }
    if (
      (value.eventResultSha256 === null &&
        value.eventResultDetailsSha256 !== null) ||
      (value.eventResultSha256 !== null && !detailsMatched)
    ) {
      context.addIssue({
        code: "custom",
        path: ["eventResultDetailsSha256"],
        message: "R3 final ToolResult details/event facts disagree",
      });
    }
    const modelVisible =
      value.availableToModelAtAgentTurnOrdinal !== null &&
      value.modelAvailabilityReceiptSha256 !== null;
    if (
      (value.availableToModelAtAgentTurnOrdinal === null) !==
        (value.modelAvailabilityReceiptSha256 === null) ||
      (modelVisible && !value.finalResultMatched) ||
      (value.availableToModelAtAgentTurnOrdinal !== null &&
        value.availableToModelAtAgentTurnOrdinal <=
          value.toolResultProducedInAgentTurnOrdinal)
    ) {
      context.addIssue({
        code: "custom",
        path: ["availableToModelAtAgentTurnOrdinal"],
        message:
          "R3 ToolResult model availability requires a later observed Agent turn",
      });
    }
    const { recordContentSha256, ...basis } = value;
    if (recordContentSha256 !== hashJson(basis)) {
      context.addIssue({
        code: "custom",
        path: ["recordContentSha256"],
        message: "R3 Agent delivery record hash does not match",
      });
    }
  });
export type M7R3AgentToolDeliveryRecordV1 = z.infer<
  typeof M7R3AgentToolDeliveryRecordV1Schema
>;

const integrityFailureSchema = z.enum([
  "tool_start_outside_turn",
  "duplicate_tool_start",
  "tool_arguments_not_json",
  "tool_return_without_start",
  "duplicate_tool_return",
  "duplicate_host_return_ordinal",
  "tool_end_without_start",
  "tool_end_without_host_result",
  "tool_identity_mismatch",
  "tool_result_not_json",
  "tool_result_details_not_json",
  "final_result_mismatch",
  "final_result_details_mismatch",
  "duplicate_tool_end",
  "source_observation_without_tool_start",
  "source_observation_tool_identity_mismatch",
  "source_identity_regressed_to_baseline",
]);
export const M7R3AgentDeliveryIntegrityFailureV1Schema = integrityFailureSchema;
export type M7R3AgentDeliveryIntegrityFailureV1 = z.infer<
  typeof M7R3AgentDeliveryIntegrityFailureV1Schema
>;

const snapshotBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-agent-delivery-trace"),
    observedPiEventCount: z.number().int().nonnegative(),
    observedAgentTurnCount: z.number().int().nonnegative(),
    deliveries: z.array(M7R3AgentToolDeliveryRecordV1Schema).max(100_000),
    firstHostObservedSourceChange:
      M7R3HostObservedSourceChangeBoundaryV1Schema.nullable(),
    integrityFailures: z.array(integrityFailureSchema).max(32),
  })
  .strict();

export const M7R3AgentDeliveryTraceV1Schema = snapshotBasisSchema
  .extend({ recordContentSha256: Sha256DigestV1Schema })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.integrityFailures).size !== value.integrityFailures.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["integrityFailures"],
        message: "R3 delivery integrity failures must be unique",
      });
    }
    const { recordContentSha256, ...basis } = value;
    if (recordContentSha256 !== hashJson(basis)) {
      context.addIssue({
        code: "custom",
        path: ["recordContentSha256"],
        message: "R3 Agent delivery trace hash does not match",
      });
    }
  });
export type M7R3AgentDeliveryTraceV1 = z.infer<
  typeof M7R3AgentDeliveryTraceV1Schema
>;

interface StartedTool {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly issuedInAgentTurnOrdinal: number;
  readonly toolArgumentsSha256: Sha256DigestV1;
}

interface ProducedTool extends StartedTool {
  readonly toolKind: "game" | "coding";
  readonly hostToolReturnOrdinal: number;
  readonly finalResultSha256: Sha256DigestV1;
  readonly finalResultDetailsSha256: Sha256DigestV1 | null;
  piEventOrdinal: number | null;
  eventResultSha256: Sha256DigestV1 | null;
  eventResultDetailsSha256: Sha256DigestV1 | null;
  eventReceiptSha256: Sha256DigestV1 | null;
  availableToModelAtAgentTurnOrdinal: number | null;
  modelAvailabilityReceiptSha256: Sha256DigestV1 | null;
}

export interface M7R3AgentDeliveryTrackerV1 {
  /** Pass directly to `runVNextPiTurnWithSdk({ onEvent })`. */
  readonly onEvent: (event: unknown) => void;
  /** Call only after the final ToolDefinition result has been constructed. */
  readonly recordFinalToolResult: (input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly toolKind: "game" | "coding";
    readonly hostToolReturnOrdinal: number;
    readonly finalResult: unknown;
  }) => void;
  /** Call after a coding tool return when Host rehashing finds a new tree. */
  readonly recordCodingSourceObservation: (input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly hostToolReturnOrdinal: number;
    readonly baselineSourceSha256: Sha256DigestV1;
    readonly observedSourceSha256: Sha256DigestV1;
    readonly observedAt: string;
  }) => void;
  readonly snapshot: () => M7R3AgentDeliveryTraceV1;
  readonly agentVisibleFinalToolResult: (
    toolCallId: string,
  ) => M7R3AgentVisibleFinalToolResultV1 | null;
}

/**
 * Pi eventually serializes a ToolResult into model context. Optional
 * `undefined` object properties therefore are not model-visible, even though
 * they can still exist on the in-memory result emitted by the SDK. Hash the
 * strict JSON round-trip projection at both the final ToolDefinition return
 * and Pi's `tool_execution_end` event. This preserves every JSON-visible byte
 * while making the comparison match the representation delivered to a model.
 */
const parseJsonRoundTrip = (value: unknown): JsonValue | null => {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return null;
    const decoded: unknown = JSON.parse(encoded);
    const parsed = JsonValueSchema.safeParse(decoded);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

interface ToolResultProjectionV1 {
  readonly resultSha256: Sha256DigestV1;
  readonly detailsSha256: Sha256DigestV1 | null;
}

const parseToolResultProjection = (
  value: unknown,
): ToolResultProjectionV1 | null => {
  const result = parseJsonRoundTrip(value);
  if (result === null) return null;
  const details =
    typeof result === "object" && !Array.isArray(result) && "details" in result
      ? JsonValueSchema.safeParse(result.details)
      : null;
  return {
    resultSha256: hashJson(result),
    detailsSha256: details?.success === true ? hashJson(details.data) : null,
  };
};

export const createM7R3AgentDeliveryTrackerV1 =
  (): M7R3AgentDeliveryTrackerV1 => {
    let piEventOrdinal = 0;
    let agentTurnOrdinal = 0;
    const starts = new Map<string, StartedTool>();
    const produced = new Map<string, ProducedTool>();
    const hostReturnOrdinals = new Set<number>();
    const failures = new Set<M7R3AgentDeliveryIntegrityFailureV1>();
    let firstSourceChange: M7R3HostObservedSourceChangeBoundaryV1 | null = null;

    const onEvent = (event: unknown): void => {
      piEventOrdinal += 1;
      if (typeof event !== "object" || event === null || !("type" in event))
        return;
      if (event.type === "turn_start") {
        agentTurnOrdinal += 1;
        for (const entry of produced.values()) {
          if (
            entry.eventReceiptSha256 !== null &&
            entry.availableToModelAtAgentTurnOrdinal === null &&
            agentTurnOrdinal > entry.issuedInAgentTurnOrdinal
          ) {
            entry.availableToModelAtAgentTurnOrdinal = agentTurnOrdinal;
            entry.modelAvailabilityReceiptSha256 = hashJson({
              schemaVersion: 1,
              eventType: "turn_start",
              piEventOrdinal,
              agentTurnOrdinal,
              toolCallId: entry.toolCallId,
              toolArgumentsSha256: entry.toolArgumentsSha256,
              finalResultSha256: entry.finalResultSha256,
              finalResultDetailsSha256: entry.finalResultDetailsSha256,
            });
          }
        }
        return;
      }
      if (event.type === "tool_execution_start") {
        if (
          !("toolCallId" in event) ||
          typeof event.toolCallId !== "string" ||
          !("toolName" in event) ||
          typeof event.toolName !== "string" ||
          !("args" in event)
        ) {
          failures.add("tool_identity_mismatch");
          return;
        }
        if (agentTurnOrdinal < 1) {
          failures.add("tool_start_outside_turn");
          return;
        }
        if (starts.has(event.toolCallId)) {
          failures.add("duplicate_tool_start");
          return;
        }
        const toolArguments = parseJsonRoundTrip(event.args);
        if (toolArguments === null) {
          failures.add("tool_arguments_not_json");
          return;
        }
        starts.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          issuedInAgentTurnOrdinal: agentTurnOrdinal,
          toolArgumentsSha256: hashJson(toolArguments),
        });
        return;
      }
      if (event.type !== "tool_execution_end") return;
      if (
        !("toolCallId" in event) ||
        typeof event.toolCallId !== "string" ||
        !("toolName" in event) ||
        typeof event.toolName !== "string" ||
        !("result" in event) ||
        !("isError" in event) ||
        typeof event.isError !== "boolean"
      ) {
        failures.add("tool_identity_mismatch");
        return;
      }
      const start = starts.get(event.toolCallId);
      if (start === undefined) {
        failures.add("tool_end_without_start");
        return;
      }
      const entry = produced.get(event.toolCallId);
      if (entry === undefined) {
        failures.add("tool_end_without_host_result");
        return;
      }
      if (entry.piEventOrdinal !== null) {
        failures.add("duplicate_tool_end");
        return;
      }
      if (
        event.toolName !== entry.toolName ||
        start.toolName !== entry.toolName
      ) {
        failures.add("tool_identity_mismatch");
        return;
      }
      const eventResult = parseToolResultProjection(event.result);
      if (eventResult === null) {
        failures.add("tool_result_not_json");
        return;
      }
      if (eventResult.resultSha256 !== entry.finalResultSha256) {
        failures.add("final_result_mismatch");
        return;
      }
      if (eventResult.detailsSha256 !== entry.finalResultDetailsSha256) {
        failures.add("final_result_details_mismatch");
        return;
      }
      entry.piEventOrdinal = piEventOrdinal;
      entry.eventResultSha256 = eventResult.resultSha256;
      entry.eventResultDetailsSha256 = eventResult.detailsSha256;
      entry.eventReceiptSha256 = hashJson({
        schemaVersion: 1,
        eventType: "tool_execution_end",
        piEventOrdinal,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        toolArgumentsSha256: entry.toolArgumentsSha256,
        finalResultSha256: eventResult.resultSha256,
        finalResultDetailsSha256: eventResult.detailsSha256,
        isError: event.isError,
      });
    };

    const recordFinalToolResult: M7R3AgentDeliveryTrackerV1["recordFinalToolResult"] =
      (input): void => {
        const start = starts.get(input.toolCallId);
        if (start === undefined) {
          failures.add("tool_return_without_start");
          return;
        }
        if (produced.has(input.toolCallId)) {
          failures.add("duplicate_tool_return");
          return;
        }
        if (hostReturnOrdinals.has(input.hostToolReturnOrdinal)) {
          failures.add("duplicate_host_return_ordinal");
          return;
        }
        if (start.toolName !== input.toolName) {
          failures.add("tool_identity_mismatch");
          return;
        }
        const finalResult = parseToolResultProjection(input.finalResult);
        if (finalResult === null) {
          failures.add("tool_result_not_json");
          return;
        }
        if (input.toolKind === "game" && finalResult.detailsSha256 === null) {
          failures.add("tool_result_details_not_json");
          return;
        }
        hostReturnOrdinals.add(input.hostToolReturnOrdinal);
        produced.set(input.toolCallId, {
          ...start,
          toolKind: input.toolKind,
          hostToolReturnOrdinal: positiveSafeIntegerSchema.parse(
            input.hostToolReturnOrdinal,
          ),
          finalResultSha256: finalResult.resultSha256,
          finalResultDetailsSha256: finalResult.detailsSha256,
          piEventOrdinal: null,
          eventResultSha256: null,
          eventResultDetailsSha256: null,
          eventReceiptSha256: null,
          availableToModelAtAgentTurnOrdinal: null,
          modelAvailabilityReceiptSha256: null,
        });
      };

    const recordCodingSourceObservation: M7R3AgentDeliveryTrackerV1["recordCodingSourceObservation"] =
      (input): void => {
        const start = starts.get(input.toolCallId);
        if (start === undefined) {
          failures.add("source_observation_without_tool_start");
          return;
        }
        const entry = produced.get(input.toolCallId);
        if (
          start.toolName !== input.toolName ||
          (entry !== undefined &&
            (entry.toolKind !== "coding" ||
              entry.toolName !== input.toolName ||
              entry.hostToolReturnOrdinal !== input.hostToolReturnOrdinal))
        ) {
          failures.add("source_observation_tool_identity_mismatch");
          return;
        }
        positiveSafeIntegerSchema.parse(input.hostToolReturnOrdinal);
        if (entry === undefined) {
          if (hostReturnOrdinals.has(input.hostToolReturnOrdinal)) {
            failures.add("duplicate_host_return_ordinal");
            return;
          }
          hostReturnOrdinals.add(input.hostToolReturnOrdinal);
        }
        if (firstSourceChange !== null) {
          if (input.observedSourceSha256 === input.baselineSourceSha256)
            failures.add("source_identity_regressed_to_baseline");
          return;
        }
        if (input.observedSourceSha256 === input.baselineSourceSha256) return;
        firstSourceChange = M7R3HostObservedSourceChangeBoundaryV1Schema.parse({
          schemaVersion: 1,
          hostToolReturnOrdinal: input.hostToolReturnOrdinal,
          sourceChangingToolIssuedInAgentTurnOrdinal:
            start.issuedInAgentTurnOrdinal,
          boundary: "coding_tool_return",
          sourceSha256: input.observedSourceSha256,
          buildId: null,
          observedAt: input.observedAt,
        });
      };

    const deliveryRecord = (
      entry: ProducedTool,
    ): M7R3AgentToolDeliveryRecordV1 => {
      const basis = deliveryRecordBasisSchema.parse({
        schemaVersion: 1,
        resultProjectionKind: "json-roundtrip-v1",
        toolCallId: entry.toolCallId,
        toolName: entry.toolName,
        toolKind: entry.toolKind,
        toolArgumentsSha256: entry.toolArgumentsSha256,
        toolResultProducedInAgentTurnOrdinal: entry.issuedInAgentTurnOrdinal,
        hostToolReturnOrdinal: entry.hostToolReturnOrdinal,
        finalResultSha256: entry.finalResultSha256,
        finalResultDetailsSha256: entry.finalResultDetailsSha256,
        piEventOrdinal: entry.piEventOrdinal,
        eventResultSha256: entry.eventResultSha256,
        eventResultDetailsSha256: entry.eventResultDetailsSha256,
        finalResultMatched:
          entry.eventReceiptSha256 !== null &&
          entry.eventResultSha256 === entry.finalResultSha256 &&
          entry.eventResultDetailsSha256 === entry.finalResultDetailsSha256,
        availableToModelAtAgentTurnOrdinal:
          entry.availableToModelAtAgentTurnOrdinal,
        eventReceiptSha256: entry.eventReceiptSha256,
        modelAvailabilityReceiptSha256: entry.modelAvailabilityReceiptSha256,
      });
      return M7R3AgentToolDeliveryRecordV1Schema.parse({
        ...basis,
        recordContentSha256: hashJson(basis),
      });
    };

    const snapshot = (): M7R3AgentDeliveryTraceV1 => {
      const basis = snapshotBasisSchema.parse({
        schemaVersion: 1,
        recordKind: "m7-r3-agent-delivery-trace",
        observedPiEventCount: piEventOrdinal,
        observedAgentTurnCount: agentTurnOrdinal,
        deliveries: [...produced.values()]
          .sort(
            (left, right) =>
              left.hostToolReturnOrdinal - right.hostToolReturnOrdinal,
          )
          .map(deliveryRecord),
        firstHostObservedSourceChange: firstSourceChange,
        integrityFailures: integrityFailureSchema.options.filter((failure) =>
          failures.has(failure),
        ),
      });
      return M7R3AgentDeliveryTraceV1Schema.parse({
        ...basis,
        recordContentSha256: hashJson(basis),
      });
    };

    const agentVisibleFinalToolResult = (
      toolCallId: string,
    ): M7R3AgentVisibleFinalToolResultV1 | null => {
      const entry = produced.get(toolCallId);
      if (
        entry === undefined ||
        entry.toolKind !== "game" ||
        entry.finalResultDetailsSha256 === null ||
        entry.piEventOrdinal === null ||
        entry.eventReceiptSha256 === null ||
        entry.availableToModelAtAgentTurnOrdinal === null ||
        entry.modelAvailabilityReceiptSha256 === null
      ) {
        return null;
      }
      return M7R3AgentVisibleFinalToolResultV1Schema.parse({
        schemaVersion: 1,
        eventType: "tool_execution_end",
        resultProjectionKind: "json-roundtrip-v1",
        piEventOrdinal: entry.piEventOrdinal,
        toolResultProducedInAgentTurnOrdinal: entry.issuedInAgentTurnOrdinal,
        availableToModelAtAgentTurnOrdinal:
          entry.availableToModelAtAgentTurnOrdinal,
        toolCallId: entry.toolCallId,
        toolName: entry.toolName,
        hostToolReturnOrdinal: entry.hostToolReturnOrdinal,
        finalResultSha256: entry.finalResultSha256,
        finalResultDetailsSha256: entry.finalResultDetailsSha256,
        eventReceiptSha256: entry.eventReceiptSha256,
        modelAvailabilityReceiptSha256: entry.modelAvailabilityReceiptSha256,
      });
    };

    return Object.freeze({
      onEvent,
      recordFinalToolResult,
      recordCodingSourceObservation,
      snapshot,
      agentVisibleFinalToolResult,
    });
  };

export const m7R3AgentDeliveryTraceCanonicalJsonV1 = (
  trace: M7R3AgentDeliveryTraceV1,
): string => canonicalJson(M7R3AgentDeliveryTraceV1Schema.parse(trace));
