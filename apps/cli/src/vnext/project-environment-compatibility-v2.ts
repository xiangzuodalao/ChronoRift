import { randomUUID } from "node:crypto";

import {
  AdapterCompatibilityReceiptV2Schema,
  asAdapterCompatibilityReceiptId,
  type BuildId,
  type ProjectAdapterRevisionV1,
  type ProjectEnvironmentRevisionV1,
  type ProjectToolchainReceiptId,
  type SourceId,
  type TaskId,
} from "@chronorift/domain";
import {
  contentHash,
  type ProjectEnvironmentTaskStoreV1,
} from "@chronorift/json-artifacts";

import type { ProjectEnvironmentGameRuntimeV2 } from "./project-environment-game-runtime-v2.js";

type ToolResult =
  | {
      readonly outcome: "success";
      readonly output: Readonly<Record<string, unknown>>;
    }
  | {
      readonly outcome: "error";
      readonly output?: undefined;
      readonly message: string;
    };

const toolResult = (value: unknown): ToolResult => {
  if (value === null || typeof value !== "object")
    return { outcome: "error", message: "malformed tool result" };
  const record = value as Readonly<Record<string, unknown>>;
  if (
    record.outcome !== "success" ||
    record.output === null ||
    typeof record.output !== "object"
  )
    return {
      outcome: "error",
      message:
        record.error !== null && typeof record.error === "object"
          ? text((record.error as Readonly<Record<string, unknown>>).message)
          : "tool returned an error",
    };
  return {
    outcome: "success",
    output: record.output as Readonly<Record<string, unknown>>,
  };
};
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";
const rows = (value: ToolResult): readonly unknown[] =>
  value.outcome === "success" && Array.isArray(value.output.rows)
    ? value.output.rows
    : [];

const invoke = (
  runtime: ProjectEnvironmentGameRuntimeV2,
  taskId: string,
  toolName: string,
  input: Record<string, unknown>,
) =>
  runtime.invoke({
    schemaVersion: 1,
    toolCallId: `compatibility-v2.${toolName}.${randomUUID()}`,
    toolName: toolName as never,
    input: { schemaVersion: 1, taskId, ...input },
  });

export async function runProjectEnvironmentCompatibilitySmokeV2(input: {
  readonly runtime: ProjectEnvironmentGameRuntimeV2;
  readonly taskStore: ProjectEnvironmentTaskStoreV1;
  readonly taskId: TaskId;
  readonly buildId: BuildId;
  readonly buildSourceId: SourceId;
  readonly revision: ProjectEnvironmentRevisionV1;
  readonly adapterRevision: ProjectAdapterRevisionV1;
  readonly toolchainReceiptId: ProjectToolchainReceiptId;
  readonly launchTargetId: string;
  readonly now?: () => string;
}) {
  const launch = toolResult(
    await invoke(input.runtime, input.taskId, "game_launch", {
      buildId: input.buildId,
      launchTargetId: input.launchTargetId,
      parameters: {},
    }),
  );
  let entities: ToolResult = { outcome: "error", message: "not run" },
    state: ToolResult = { outcome: "error", message: "not run" },
    events: ToolResult = { outcome: "error", message: "not run" },
    configured: ToolResult = { outcome: "error", message: "not run" },
    pinned: ToolResult = { outcome: "error", message: "not run" },
    stop: ToolResult = { outcome: "error", message: "not run" };
  if (launch.outcome === "success") {
    const executionId = text(launch.output.executionId);
    entities = toolResult(
      await invoke(input.runtime, input.taskId, "game_query", {
        executionId,
        select: "entities",
        limit: 200,
      }),
    );
    state = toolResult(
      await invoke(input.runtime, input.taskId, "game_query", {
        executionId,
        select: "state",
        limit: 200,
      }),
    );
    events = toolResult(
      await invoke(input.runtime, input.taskId, "game_query", {
        executionId,
        select: "events",
        limit: 200,
      }),
    );
    configured = toolResult(
      await invoke(input.runtime, input.taskId, "game_capture_configure", {
        runtimeId: text(launch.output.runtimeId),
        profile: {
          channels: ["entity", "state", "event", "runtime_error"],
          retention: { clockDomain: "process_frame", before: 0, after: 0 },
          sampling: [],
          triggers: [],
        },
      }),
    );
    pinned = toolResult(
      await invoke(input.runtime, input.taskId, "game_capture_pin", {
        runtimeId: text(launch.output.runtimeId),
        anchor: { kind: "now" },
        before: 0,
        after: 0,
      }),
    );
    stop = toolResult(
      await invoke(input.runtime, input.taskId, "game_stop", {
        runtimeId: text(launch.output.runtimeId),
      }),
    );
  }
  const traces =
    launch.outcome === "success" && stop.outcome === "success"
      ? input.runtime.lastDynamicTraces
      : [];
  const failures = [
    launch,
    entities,
    state,
    events,
    configured,
    pinned,
    stop,
  ].flatMap((value, index) =>
    value.outcome === "success"
      ? []
      : [`V2 compatibility step ${index} failed: ${value.message}`],
  );
  if (
    rows(entities).length < 3 ||
    rows(state).length < 4 ||
    rows(events).length < 2
  )
    failures.push(
      "V2 compatibility queries did not contain a complete dynamic projection",
    );
  if (traces.length === 0)
    failures.push("V2 compatibility did not recognize a dynamic trace");
  const cleanup =
    stop.outcome === "success"
      ? stop.output.cleanup
      : {
          schemaVersion: 1,
          processTreeTerminated: false,
          runtimeExited: false,
          bridgeExited: false,
          isolationGroupEmpty: false,
          scopeRemoved: false,
          scratchRemoved: false,
          storageReconciled: false,
        };
  const coverage =
    stop.outcome === "success" && Array.isArray(stop.output.coverage)
      ? stop.output.coverage
      : [
          {
            schemaVersion: 1,
            channelId: "project_adapter_observations_v2",
            status: "unavailable",
            observedRecords: 0,
            droppedRecords: 0,
            overwrittenRecords: 0,
            limitations: ["V2 compatibility runtime did not produce coverage."],
          },
        ];
  const content = {
    schemaVersion: 2 as const,
    taskId: input.taskId,
    buildId: input.buildId,
    sourceId: input.buildSourceId,
    environmentRevisionId: input.revision.environmentRevisionId,
    adapterRevisionId: input.adapterRevision.adapterRevisionId,
    toolchainReceiptId: input.toolchainReceiptId,
    launchTargetId: input.launchTargetId,
    bridgeHandshakeObserved: launch.outcome === "success",
    instrumentedLaunchObserved: launch.outcome === "success",
    queryObservations: {
      schemaVersion: 1 as const,
      entityQueryObserved: entities.outcome === "success",
      stateQueryObserved: state.outcome === "success",
      entityRows: rows(entities).length,
      stateRows: rows(state).length,
    },
    eventQueryObserved: events.outcome === "success",
    eventRows: rows(events).length,
    dynamicCaptureWindowId:
      pinned.outcome === "success"
        ? text(pinned.output.captureWindowId)
        : "capture-window.v2.missing",
    coverage,
    capabilitySet: input.adapterRevision.capabilitySet,
    cleanup,
    outcome:
      failures.length === 0
        ? ("compatible" as const)
        : ("incompatible" as const),
    failures,
    observedAt: (input.now ?? (() => new Date().toISOString()))(),
    observationProtocolVersion: 2 as const,
    adapterSdkVersion: 2 as const,
    dynamicTraces: traces,
  };
  const receipt = AdapterCompatibilityReceiptV2Schema.parse({
    ...content,
    receiptId: asAdapterCompatibilityReceiptId(
      `compatibility:v2:${contentHash(JSON.parse(JSON.stringify(content)) as never)}`,
    ),
  });
  await input.taskStore.putCompatibilityReceiptV2Once(receipt);
  return receipt;
}
