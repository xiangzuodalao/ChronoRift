import { asSha256DigestV1, type JsonValue } from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";
import { describe, expect, it } from "vitest";

import type { M7AgentGameToolExchangeV1 } from "./m7-project-environment-paired-agent.js";
import { M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1 } from "./m7-patrol-trajectory.js";
import type { M7PatrolEntityStateV1 } from "./m7-patrol-sensor.js";
import { createM7R3AgentDeliveryTrackerV1 } from "./m7-r3-agent-delivery.js";
import {
  classifyM7R3EarliestAgentVisibleTrajectoryPrefixV1,
  createM7R3PatrolTimelineFromAgentVisibleResponsesV1,
} from "./m7-r3-trajectory-delivery.js";

const sha = (label: string) => asSha256DigestV1(contentHash(label));
const taskId = "task:m7-r3-runtime";
const entity = (
  input: Partial<M7PatrolEntityStateV1> = {},
): M7PatrolEntityStateV1 => ({
  entity_id: "enemy:one",
  name: "Enemy",
  start_direction: 1,
  direction: 1,
  fall_off_edge: false,
  speed: 100,
  position_x: 0,
  position_y: 0,
  velocity_x: 100,
  velocity_y: 0,
  grounded: true,
  ...input,
});
const response = (
  ordinal: number,
  executionId: string,
  samples: readonly {
    readonly sequence: number;
    readonly state: M7PatrolEntityStateV1;
  }[],
  responseTaskId = taskId,
): JsonValue => ({
  schemaVersion: 1,
  toolCallId: `call-${ordinal}`,
  outcome: "success",
  output: {
    schemaVersion: 1,
    taskId: responseTaskId,
    executionId,
    rows: samples.map((sample) => ({
      schemaVersion: 1,
      rowId: `query-row:${executionId}:${sample.sequence}`,
      kind: "state",
      clock: null,
      value: {
        schemaVersion: 1,
        kind: "state_sample",
        recordSequence: sample.sequence,
        clock: { processFrame: sample.sequence },
        payload: {
          stateDomainId: "patrol.motion",
          semanticCoverage: "declared",
          value: { agents: [sample.state] },
        },
      },
    })),
    nextCursor: null,
    coverage: [
      {
        schemaVersion: 1,
        channelId: "state",
        status: "complete",
        observedRecords: samples.length,
        droppedRecords: 0,
        overwrittenRecords: 0,
        limitations: [],
      },
    ],
    loss: [],
    limitations: [],
  },
});
const finalResult = (details: JsonValue) => ({
  content: [{ type: "text", text: JSON.stringify(details) }],
  details,
});
const exchange = (
  ordinal: number,
  details: JsonValue,
  inputExecutionId = "execution:r3",
  inputTaskId = taskId,
): M7AgentGameToolExchangeV1 => ({
  schemaVersion: 1,
  ordinal,
  toolCallId: `call-${ordinal}`,
  toolName: "game_query",
  input: {
    schemaVersion: 1,
    taskId: inputTaskId,
    executionId: inputExecutionId,
    select: "state",
    limit: 200,
  },
  response: details,
  observedAt: `2026-08-15T12:00:0${ordinal}.000Z`,
  hostToolReturnOrdinal: ordinal,
});

describe("M7 R3 Agent-visible trajectory prefix", () => {
  it("strictly rebuilds public patrol frames and rejects conflicting sequences", () => {
    const first = response(1, "execution:r3", [
      { sequence: 1, state: entity() },
      { sequence: 2, state: entity({ velocity_x: 0, position_x: 1 }) },
    ]);
    expect(
      createM7R3PatrolTimelineFromAgentVisibleResponsesV1({
        executionId: "execution:r3",
        exchanges: [exchange(1, first)],
      }),
    ).toMatchObject({
      execution_id: "execution:r3",
      frames: [{ sample_ordinal: 1 }, { sample_ordinal: 2 }],
    });
    const conflicting = response(2, "execution:r3", [
      { sequence: 2, state: entity({ direction: -1 }) },
    ]);
    expect(() =>
      createM7R3PatrolTimelineFromAgentVisibleResponsesV1({
        executionId: "execution:r3",
        exchanges: [exchange(1, first), exchange(2, conflicting)],
      }),
    ).toThrow(/conflicting/u);
  });

  it("uses only structured PE queries for the exact Task/Execution and rejects crossed lineage", () => {
    const expected = response(1, "execution:r3", [
      { sequence: 1, state: entity() },
      { sequence: 2, state: entity({ position_x: 2 }) },
    ]);
    const unrelated = response(2, "execution:other", [
      { sequence: 90, state: entity({ position_x: 90 }) },
      { sequence: 91, state: entity({ position_x: 91 }) },
    ]);
    expect(
      createM7R3PatrolTimelineFromAgentVisibleResponsesV1({
        executionId: "execution:r3",
        exchanges: [
          exchange(1, expected),
          exchange(2, unrelated, "execution:other"),
        ],
      }),
    ).toMatchObject({
      execution_id: "execution:r3",
      frames: [{ sample_ordinal: 1 }, { sample_ordinal: 2 }],
    });

    expect(() =>
      createM7R3PatrolTimelineFromAgentVisibleResponsesV1({
        executionId: "execution:r3",
        exchanges: [exchange(2, unrelated)],
      }),
    ).toThrow(/input\/response task or execution crossed/u);
    const crossedTask = response(
      3,
      "execution:r3",
      [
        { sequence: 3, state: entity() },
        { sequence: 4, state: entity({ position_x: 4 }) },
      ],
      "task:m7-r3-other",
    );
    expect(() =>
      createM7R3PatrolTimelineFromAgentVisibleResponsesV1({
        executionId: "execution:r3",
        exchanges: [exchange(3, crossedTask)],
      }),
    ).toThrow(/input\/response task or execution crossed/u);
  });

  it("selects only a prefix that Pi delivered before a later model turn", () => {
    const tracker = createM7R3AgentDeliveryTrackerV1();
    const detailsOne = response(1, "execution:r3", [
      { sequence: 1, state: entity() },
    ]);
    const detailsTwo = response(2, "execution:r3", [
      { sequence: 2, state: entity({ velocity_x: 0, position_x: 1 }) },
      { sequence: 3, state: entity({ velocity_x: 0, position_x: 1 }) },
    ]);
    const exchanges = [exchange(1, detailsOne), exchange(2, detailsTwo)];
    tracker.onEvent({ type: "turn_start" });
    for (const item of exchanges) {
      const result = finalResult(item.response);
      tracker.onEvent({
        type: "tool_execution_start",
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        args: item.input,
      });
      tracker.recordFinalToolResult({
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        toolKind: "game",
        hostToolReturnOrdinal: item.hostToolReturnOrdinal,
        finalResult: result,
      });
      tracker.onEvent({
        type: "tool_execution_end",
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        result,
        isError: false,
      });
    }
    expect(
      classifyM7R3EarliestAgentVisibleTrajectoryPrefixV1({
        executionId: "execution:r3",
        exchanges,
        deliveryTrace: tracker.snapshot(),
        expectedWitnessKinds: ["grounded_stall"],
        classifierConfig: M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1,
      }),
    ).toBeNull();

    tracker.onEvent({ type: "turn_start" });
    expect(
      classifyM7R3EarliestAgentVisibleTrajectoryPrefixV1({
        executionId: "execution:r3",
        exchanges,
        deliveryTrace: tracker.snapshot(),
        expectedWitnessKinds: ["grounded_stall"],
        classifierConfig: M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1,
      }),
    ).toMatchObject({
      agentVisibleAtHostToolReturnOrdinal: 2,
      expectedWitnessKinds: ["grounded_stall"],
      agentVisibleFinalToolResult: {
        availableToModelAtAgentTurnOrdinal: 2,
      },
    });
  });

  it("does not use intentional-fall or delivery-integrity failures", () => {
    const tracker = createM7R3AgentDeliveryTrackerV1();
    const details = response(1, "execution:r3", [
      { sequence: 1, state: entity({ fall_off_edge: true }) },
      {
        sequence: 2,
        state: entity({ fall_off_edge: true, grounded: false, velocity_y: 20 }),
      },
    ]);
    const item = exchange(1, details);
    const result = finalResult(details);
    tracker.onEvent({ type: "turn_start" });
    tracker.onEvent({
      type: "tool_execution_start",
      toolCallId: item.toolCallId,
      toolName: item.toolName,
      args: {},
    });
    tracker.recordFinalToolResult({
      toolCallId: item.toolCallId,
      toolName: item.toolName,
      toolKind: "game",
      hostToolReturnOrdinal: 1,
      finalResult: result,
    });
    tracker.onEvent({
      type: "tool_execution_end",
      toolCallId: item.toolCallId,
      toolName: item.toolName,
      result: { ...result, details: { changed: sha("mismatch") } },
      isError: false,
    });
    tracker.onEvent({ type: "turn_start" });

    expect(
      classifyM7R3EarliestAgentVisibleTrajectoryPrefixV1({
        executionId: "execution:r3",
        exchanges: [item],
        deliveryTrace: tracker.snapshot(),
        expectedWitnessKinds: ["ground_contact_loss"],
        classifierConfig: M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1,
      }),
    ).toBeNull();
  });

  it("rejects substituting raw response details after the exact Pi ToolResult", () => {
    const tracker = createM7R3AgentDeliveryTrackerV1();
    const delivered = response(1, "execution:r3", [
      { sequence: 1, state: entity() },
      { sequence: 2, state: entity({ velocity_x: 0, position_x: 1 }) },
      { sequence: 3, state: entity({ velocity_x: 0, position_x: 1 }) },
    ]);
    const item = exchange(1, delivered);
    const result = finalResult(delivered);
    tracker.onEvent({ type: "turn_start" });
    tracker.onEvent({
      type: "tool_execution_start",
      toolCallId: item.toolCallId,
      toolName: item.toolName,
      args: item.input,
    });
    tracker.recordFinalToolResult({
      toolCallId: item.toolCallId,
      toolName: item.toolName,
      toolKind: "game",
      hostToolReturnOrdinal: item.hostToolReturnOrdinal,
      finalResult: result,
    });
    tracker.onEvent({
      type: "tool_execution_end",
      toolCallId: item.toolCallId,
      toolName: item.toolName,
      result,
      isError: false,
    });
    tracker.onEvent({ type: "turn_start" });

    const substituted = exchange(
      1,
      response(1, "execution:r3", [
        { sequence: 1, state: entity() },
        { sequence: 2, state: entity({ direction: -1 }) },
      ]),
    );
    expect(() =>
      classifyM7R3EarliestAgentVisibleTrajectoryPrefixV1({
        executionId: "execution:r3",
        exchanges: [substituted],
        deliveryTrace: tracker.snapshot(),
        expectedWitnessKinds: ["grounded_stall"],
        classifierConfig: M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1,
      }),
    ).toThrow(/substituted/u);
  });
});
