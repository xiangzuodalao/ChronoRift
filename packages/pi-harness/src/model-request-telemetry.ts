import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

export interface PiModelRequestTiming {
  readonly requestId: string;
  readonly boundary: "pi-stream-function";
  readonly provider: string;
  readonly model: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly outcome: "in_flight" | "completed" | "error" | "aborted";
  readonly stopReason: string | null;
  readonly persistenceFailed?: true;
}

/**
 * Pi 0.83 emits message_start after the stream starts, so it omits request
 * preparation and first-response latency. Wrap the public stream function
 * instead, retaining the original stream and its single consumer. Pi retries
 * and compaction invoke this function separately; internal HTTP retries do not.
 */
export function observePiModelRequests(
  session: Pick<AgentSession, "agent" | "sessionManager">,
): { snapshot(): readonly PiModelRequestTiming[]; dispose(): void } {
  const original = session.agent.streamFunction;
  const requests: PiModelRequestTiming[] = [];
  const persist = (index: number, phase: "started" | "finished"): void => {
    try {
      session.sessionManager.appendCustomEntry("chronorift.model-request.v1", {
        schemaVersion: 1,
        phase,
        ...requests[index],
      });
    } catch {
      // A telemetry write must not turn successful provider work into a retry.
      // Keep the failed persistence observable in the eventual result snapshot.
      requests[index] = { ...requests[index]!, persistenceFailed: true };
    }
  };
  const observed: typeof original = async (model, context, options) => {
    const started = performance.now();
    const index = requests.length;
    requests.push({
      requestId: randomUUID(),
      boundary: "pi-stream-function",
      provider: model.provider,
      model: model.id,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      outcome: "in_flight",
      stopReason: null,
    });
    persist(index, "started");
    const finish = (
      outcome: Exclude<PiModelRequestTiming["outcome"], "in_flight">,
      stopReason: string | null,
    ): void => {
      requests[index] = {
        ...requests[index]!,
        finishedAt: new Date().toISOString(),
        durationMs: Math.max(0, performance.now() - started),
        outcome,
        stopReason,
      };
      persist(index, "finished");
    };
    try {
      const stream = await original(model, context, options);
      // result() observes the stream's existing completion promise; it does
      // not drain events, change provider retries, or delay the Pi consumer.
      void stream.result().then(
        (message) => {
          finish(
            message.stopReason === "error" || message.stopReason === "aborted"
              ? message.stopReason
              : "completed",
            message.stopReason,
          );
        },
        () => finish(options?.signal?.aborted ? "aborted" : "error", null),
      );
      return stream;
    } catch (error) {
      finish(options?.signal?.aborted ? "aborted" : "error", null);
      throw error;
    }
  };
  session.agent.streamFunction = observed;
  return {
    // Measurements belong to this managed instance, excluding inherited or
    // previously persisted requests. Entries in Session JSONL remain intact.
    snapshot: () => requests.map((request) => ({ ...request })),
    dispose: () => {
      if (session.agent.streamFunction === observed)
        session.agent.streamFunction = original;
    },
  };
}
