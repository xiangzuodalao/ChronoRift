import { asSha256DigestV1, type Sha256DigestV1 } from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";
import { describe, expect, it } from "vitest";

import {
  M7R3AgentDeliveryTraceV1Schema,
  createM7R3AgentDeliveryTrackerV1,
} from "./m7-r3-agent-delivery.js";

const sha = (label: string): Sha256DigestV1 =>
  asSha256DigestV1(contentHash(label));

const turnStart = (): unknown => ({ type: "turn_start" });
const toolStart = (toolCallId: string, toolName: string): unknown => ({
  type: "tool_execution_start",
  toolCallId,
  toolName,
  args: {},
});
const toolEnd = (
  toolCallId: string,
  toolName: string,
  result: unknown,
): unknown => ({
  type: "tool_execution_end",
  toolCallId,
  toolName,
  result,
  isError: false,
});

const gameResult = (positionX: number) => ({
  content: [{ type: "text", text: "Patrol state returned." }],
  details: {
    schemaVersion: 1,
    records: [
      {
        kind: "state_sample",
        payload: {
          stateDomainId: "patrol.motion",
          semanticCoverage: "declared",
          value: {
            agents: [
              {
                entity_id: "enemy:1",
                name: "Enemy",
                start_direction: 0,
                direction: -1,
                fall_off_edge: false,
                speed: 100,
                position_x: positionX,
                position_y: 10,
                velocity_x: -100,
                velocity_y: 0,
                grounded: true,
              },
            ],
          },
        },
      },
    ],
  },
});

const codingResult = { content: [{ type: "text", text: "Done" }] };

describe("M7 R3 Pi delivery tracker", () => {
  it("requires the final Pi event and a later turn before a game result is model-visible", () => {
    const tracker = createM7R3AgentDeliveryTrackerV1();
    const result = gameResult(12);

    tracker.onEvent(turnStart());
    tracker.onEvent(toolStart("call-game-1", "game_state_query"));
    tracker.recordFinalToolResult({
      toolCallId: "call-game-1",
      toolName: "game_state_query",
      toolKind: "game",
      hostToolReturnOrdinal: 1,
      finalResult: result,
    });
    expect(tracker.agentVisibleFinalToolResult("call-game-1")).toBeNull();

    tracker.onEvent(toolEnd("call-game-1", "game_state_query", result));
    expect(tracker.agentVisibleFinalToolResult("call-game-1")).toBeNull();
    expect(tracker.snapshot().deliveries[0]).toMatchObject({
      finalResultMatched: true,
      availableToModelAtAgentTurnOrdinal: null,
    });
    const matched = tracker.snapshot().deliveries[0];
    expect(matched?.toolArgumentsSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(matched?.finalResultDetailsSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(matched?.eventResultDetailsSha256).toBe(
      matched?.finalResultDetailsSha256,
    );
    expect(matched?.finalResultDetailsSha256).not.toBe(
      matched?.finalResultSha256,
    );

    tracker.onEvent(turnStart());
    expect(tracker.agentVisibleFinalToolResult("call-game-1")).toMatchObject({
      eventType: "tool_execution_end",
      toolResultProducedInAgentTurnOrdinal: 1,
      availableToModelAtAgentTurnOrdinal: 2,
      hostToolReturnOrdinal: 1,
    });
    expect(tracker.snapshot().integrityFailures).toEqual([]);
  });

  it("binds a later coding source change to the turn that issued it", () => {
    const tracker = createM7R3AgentDeliveryTrackerV1();
    const result = gameResult(0);
    tracker.onEvent(turnStart());
    tracker.onEvent(toolStart("call-game", "game_capture_pin"));
    tracker.recordFinalToolResult({
      toolCallId: "call-game",
      toolName: "game_capture_pin",
      toolKind: "game",
      hostToolReturnOrdinal: 1,
      finalResult: result,
    });
    tracker.onEvent(toolEnd("call-game", "game_capture_pin", result));
    tracker.onEvent(turnStart());

    tracker.onEvent(toolStart("call-edit", "edit"));
    tracker.recordFinalToolResult({
      toolCallId: "call-edit",
      toolName: "edit",
      toolKind: "coding",
      hostToolReturnOrdinal: 2,
      finalResult: codingResult,
    });
    tracker.recordCodingSourceObservation({
      toolCallId: "call-edit",
      toolName: "edit",
      hostToolReturnOrdinal: 2,
      baselineSourceSha256: sha("baseline"),
      observedSourceSha256: sha("candidate"),
      observedAt: "2026-08-15T12:00:00.000Z",
    });

    const trace = tracker.snapshot();
    expect(trace.firstHostObservedSourceChange).toMatchObject({
      hostToolReturnOrdinal: 2,
      sourceChangingToolIssuedInAgentTurnOrdinal: 2,
      sourceSha256: sha("candidate"),
    });
    expect(
      tracker.agentVisibleFinalToolResult("call-game")
        ?.availableToModelAtAgentTurnOrdinal,
    ).toBe(2);
  });

  it("exposes the parallel same-turn ordering that the trajectory checker rejects", () => {
    const tracker = createM7R3AgentDeliveryTrackerV1();
    const result = gameResult(5);
    tracker.onEvent(turnStart());
    tracker.onEvent(toolStart("call-game", "game_state_query"));
    tracker.onEvent(toolStart("call-write", "write"));
    tracker.recordFinalToolResult({
      toolCallId: "call-game",
      toolName: "game_state_query",
      toolKind: "game",
      hostToolReturnOrdinal: 1,
      finalResult: result,
    });
    tracker.onEvent(toolEnd("call-game", "game_state_query", result));
    tracker.recordFinalToolResult({
      toolCallId: "call-write",
      toolName: "write",
      toolKind: "coding",
      hostToolReturnOrdinal: 2,
      finalResult: codingResult,
    });
    tracker.recordCodingSourceObservation({
      toolCallId: "call-write",
      toolName: "write",
      hostToolReturnOrdinal: 2,
      baselineSourceSha256: sha("baseline"),
      observedSourceSha256: sha("candidate"),
      observedAt: "2026-08-15T12:00:00.000Z",
    });
    tracker.onEvent(toolEnd("call-write", "write", codingResult));
    tracker.onEvent(turnStart());

    const game = tracker.agentVisibleFinalToolResult("call-game");
    const change = tracker.snapshot().firstHostObservedSourceChange;
    expect(game?.availableToModelAtAgentTurnOrdinal).toBe(2);
    expect(change?.sourceChangingToolIssuedInAgentTurnOrdinal).toBe(1);
    expect(
      (game?.availableToModelAtAgentTurnOrdinal ?? 0) <=
        (change?.sourceChangingToolIssuedInAgentTurnOrdinal ?? 0),
    ).toBe(false);
  });

  it("refuses a mismatched after-hook/final event result", () => {
    const tracker = createM7R3AgentDeliveryTrackerV1();
    tracker.onEvent(turnStart());
    tracker.onEvent(toolStart("call-game", "game_state_query"));
    tracker.recordFinalToolResult({
      toolCallId: "call-game",
      toolName: "game_state_query",
      toolKind: "game",
      hostToolReturnOrdinal: 1,
      finalResult: gameResult(1),
    });
    tracker.onEvent(toolEnd("call-game", "game_state_query", gameResult(999)));
    tracker.onEvent(turnStart());

    expect(tracker.agentVisibleFinalToolResult("call-game")).toBeNull();
    expect(tracker.snapshot().integrityFailures).toContain(
      "final_result_mismatch",
    );
  });

  it("matches Pi's JSON-visible projection when optional details are undefined", () => {
    const tracker = createM7R3AgentDeliveryTrackerV1();
    const result = {
      content: [{ type: "text", text: "Done" }],
      details: { receipt: undefined, retained: true },
    };
    tracker.onEvent(turnStart());
    tracker.onEvent(toolStart("call-bash", "bash"));
    tracker.recordFinalToolResult({
      toolCallId: "call-bash",
      toolName: "bash",
      toolKind: "coding",
      hostToolReturnOrdinal: 1,
      finalResult: result,
    });
    tracker.onEvent(toolEnd("call-bash", "bash", result));
    tracker.onEvent(turnStart());

    expect(tracker.snapshot()).toMatchObject({
      integrityFailures: [],
      deliveries: [
        {
          resultProjectionKind: "json-roundtrip-v1",
          finalResultMatched: true,
          availableToModelAtAgentTurnOrdinal: 2,
        },
      ],
    });
  });

  it("retains missing host results and a later revert as integrity facts", () => {
    const tracker = createM7R3AgentDeliveryTrackerV1();
    tracker.onEvent(turnStart());
    tracker.onEvent(toolStart("missing", "game_state_query"));
    tracker.onEvent(toolEnd("missing", "game_state_query", gameResult(0)));

    tracker.onEvent(toolStart("edit", "edit"));
    tracker.recordFinalToolResult({
      toolCallId: "edit",
      toolName: "edit",
      toolKind: "coding",
      hostToolReturnOrdinal: 1,
      finalResult: codingResult,
    });
    tracker.recordCodingSourceObservation({
      toolCallId: "edit",
      toolName: "edit",
      hostToolReturnOrdinal: 1,
      baselineSourceSha256: sha("baseline"),
      observedSourceSha256: sha("candidate"),
      observedAt: "2026-08-15T12:00:00.000Z",
    });
    tracker.recordCodingSourceObservation({
      toolCallId: "edit",
      toolName: "edit",
      hostToolReturnOrdinal: 1,
      baselineSourceSha256: sha("baseline"),
      observedSourceSha256: sha("baseline"),
      observedAt: "2026-08-15T12:00:01.000Z",
    });

    expect(tracker.snapshot().integrityFailures).toEqual(
      expect.arrayContaining([
        "tool_end_without_host_result",
        "source_identity_regressed_to_baseline",
      ]),
    );
  });

  it("retains a source change from a coding tool that throws after mutating", () => {
    const tracker = createM7R3AgentDeliveryTrackerV1();
    tracker.onEvent(turnStart());
    tracker.onEvent(toolStart("call-bash", "bash"));
    tracker.recordCodingSourceObservation({
      toolCallId: "call-bash",
      toolName: "bash",
      hostToolReturnOrdinal: 1,
      baselineSourceSha256: sha("baseline"),
      observedSourceSha256: sha("candidate"),
      observedAt: "2026-08-15T12:00:00.000Z",
    });
    tracker.onEvent(
      toolEnd("call-bash", "bash", {
        content: [{ type: "text", text: "tool failed" }],
        details: {},
      }),
    );

    expect(tracker.snapshot()).toMatchObject({
      firstHostObservedSourceChange: {
        hostToolReturnOrdinal: 1,
        sourceChangingToolIssuedInAgentTurnOrdinal: 1,
      },
      integrityFailures: ["tool_end_without_host_result"],
    });
  });

  it("rejects trace tampering without retaining model prose, paths, or errors", () => {
    const tracker = createM7R3AgentDeliveryTrackerV1();
    tracker.onEvent(turnStart());
    const trace = tracker.snapshot();
    const changed = structuredClone(trace);
    changed.recordContentSha256 = sha("changed");
    expect(M7R3AgentDeliveryTraceV1Schema.safeParse(changed).success).toBe(
      false,
    );
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toMatch(
      /assistant|session|\/workspace|stack|errorMessage|secret/u,
    );
  });
});
