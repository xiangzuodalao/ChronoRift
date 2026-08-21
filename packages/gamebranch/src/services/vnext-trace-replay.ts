import {
  VNextRuntimeTraceV1Schema,
  VNextTraceReplayReceiptV1Schema,
  type BuildId,
  type ExecutionId,
  type JsonValue,
  type TaskId,
  type VNextFirstDivergenceV1,
  type VNextRuntimeTraceV1,
  type VNextTraceReplayApplicationV1,
  type VNextTraceReplayReceiptV1,
  type VNextTraceRealizationV1,
} from "@chronorift/domain";

import type { VNextTraceReplayPort } from "../ports/vnext-runtime.js";
import { jsonEqual } from "./canonical.js";

export interface VNextTraceReplayExpectation {
  readonly traceSequence: number;
  readonly subject: string;
  readonly value: JsonValue;
}

export interface VNextTraceReplayRequest {
  readonly taskId: TaskId;
  readonly targetExecutionId: ExecutionId;
  readonly targetBuildId: BuildId;
  readonly fidelityBoundary: string;
  readonly expected: readonly VNextTraceReplayExpectation[];
}

export interface VNextTraceReplayResult {
  readonly trace: VNextRuntimeTraceV1;
  readonly receipt: VNextTraceReplayReceiptV1;
}

const realizedPosition = (
  event: VNextRuntimeTraceV1["events"][number],
  realized: VNextTraceRealizationV1,
): number | null => {
  switch (event.requested.clockDomain) {
    case "process_frame":
      return realized.clock.processFrame;
    case "physics_tick":
      return realized.clock.physicsTick;
    case "simulation_time":
      return realized.clock.simulationTimeUs;
    case "render_completion":
      return realized.clock.renderFrame;
    case "host_monotonic":
      return realized.clock.hostMonotonicUs;
  }
};

export class VNextTraceReplayService {
  public constructor(private readonly port: VNextTraceReplayPort) {}

  public replay(
    inputTrace: VNextRuntimeTraceV1,
    request: VNextTraceReplayRequest,
  ): VNextTraceReplayResult {
    const trace = VNextRuntimeTraceV1Schema.parse(inputTrace);
    if (trace.taskId !== request.taskId) {
      throw new Error("trace task ownership does not match replay request");
    }
    const expectations = new Map(
      request.expected.map((expected) => [expected.traceSequence, expected]),
    );
    if (expectations.size !== request.expected.length) {
      throw new Error("replay expectations must have unique trace sequences");
    }
    const traceSequences = new Set(trace.events.map((event) => event.sequence));
    for (const expected of request.expected) {
      if (!traceSequences.has(expected.traceSequence)) {
        throw new Error(
          `replay expectation references unknown trace sequence ${expected.traceSequence}`,
        );
      }
      if (expected.subject.length === 0) {
        throw new Error("replay expectation subject must not be empty");
      }
    }

    const applications: VNextTraceReplayApplicationV1[] = [];
    const realizedEvents = [...trace.events];
    let firstDivergence: VNextFirstDivergenceV1 | null = null;
    let failure: string | null = null;

    for (const event of trace.events) {
      try {
        const result = this.port.apply(event);
        const position = realizedPosition(event, result.realized);
        const mismatched =
          position === null ||
          position !== event.requested.position ||
          result.realized.phase !== event.requested.phase;
        if (mismatched !== result.realized.quantized) {
          throw new Error(
            `runtime realization mismatch receipt is inconsistent for trace sequence ${event.sequence}`,
          );
        }
        applications.push({
          schemaVersion: 1,
          traceSequence: event.sequence,
          requested: event.requested,
          realized: result.realized,
          knownSideEffects: [...result.knownSideEffects],
        });
        realizedEvents[event.sequence] = {
          ...event,
          realized: result.realized,
        };

        const expected = expectations.get(event.sequence);
        if (
          firstDivergence === null &&
          expected !== undefined &&
          (expected.subject !== result.observed.subject ||
            !jsonEqual(expected.value, result.observed.value))
        ) {
          firstDivergence = {
            schemaVersion: 1,
            status: "observed",
            clock: result.realized.clock,
            phase: result.realized.phase,
            differenceKind: "field",
            subject: expected.subject,
            left: expected.value,
            right: result.observed.value,
            fidelityBoundary: request.fidelityBoundary,
          };
        }
      } catch (error) {
        failure =
          error instanceof Error ? error.message : "runtime replay failed";
        break;
      }
    }

    if (firstDivergence === null) {
      if (failure !== null) {
        firstDivergence = {
          schemaVersion: 1,
          status: "unavailable",
          fidelityBoundary: request.fidelityBoundary,
          reason: `replay stopped before comparison completed: ${failure}`,
        };
      } else if (request.expected.length === 0) {
        firstDivergence = {
          schemaVersion: 1,
          status: "unavailable",
          fidelityBoundary: request.fidelityBoundary,
          reason: "no source observation projection was supplied",
        };
      } else {
        firstDivergence = {
          schemaVersion: 1,
          status: "none_observed",
          fidelityBoundary: request.fidelityBoundary,
          reason:
            "no difference was observed in the supplied projection; complete runtime equivalence is not established",
        };
      }
    }

    const realizedTrace = VNextRuntimeTraceV1Schema.parse({
      ...trace,
      events: realizedEvents,
    });
    const crossBuild = trace.sourceBuildId !== request.targetBuildId;
    const limitations = [
      ...(crossBuild ? ["cross-build replay is descriptive only"] : []),
      ...(failure === null ? [] : [`runtime replay failed: ${failure}`]),
    ];
    const receipt = VNextTraceReplayReceiptV1Schema.parse({
      schemaVersion: 1,
      taskId: request.taskId,
      traceId: trace.traceId,
      sourceExecutionId: trace.sourceExecutionId,
      targetExecutionId: request.targetExecutionId,
      sourceBuildId: trace.sourceBuildId,
      targetBuildId: request.targetBuildId,
      mode: crossBuild ? "descriptive_only" : "same_build_replay",
      status: failure === null ? "completed" : "failed",
      applications,
      firstDivergence,
      limitations,
    });
    return { trace: realizedTrace, receipt };
  }
}
