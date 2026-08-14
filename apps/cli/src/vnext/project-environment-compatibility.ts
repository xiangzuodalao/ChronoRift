import { randomUUID } from "node:crypto";

import {
  AdapterCompatibilityReceiptV1Schema,
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

import type { ProjectEnvironmentGameRuntimeV1 } from "./project-environment-game-runtime.js";

const hash = (value: unknown): string =>
  contentHash(JSON.parse(JSON.stringify(value)) as never);

/** Runs the bounded launch/stop smoke used by both initial bind and reuse. */
export async function runProjectEnvironmentCompatibilitySmokeV1(input: {
  readonly runtime: ProjectEnvironmentGameRuntimeV1;
  readonly taskStore: ProjectEnvironmentTaskStoreV1;
  readonly taskId: TaskId;
  readonly buildId: BuildId;
  readonly buildSourceId: SourceId;
  readonly revision: ProjectEnvironmentRevisionV1;
  readonly adapterRevision: ProjectAdapterRevisionV1;
  readonly toolchainReceiptId: ProjectToolchainReceiptId;
  readonly launchTargetId: string;
  readonly now?: () => string;
}): Promise<ReturnType<typeof AdapterCompatibilityReceiptV1Schema.parse>> {
  const launch = (await input.runtime.invoke({
    schemaVersion: 1,
    toolCallId: `compatibility-launch.${randomUUID()}`,
    toolName: "game_launch",
    input: {
      schemaVersion: 1,
      taskId: input.taskId,
      buildId: input.buildId,
      launchTargetId: input.launchTargetId,
      parameters: {},
    },
  })) as {
    readonly outcome: "success" | "error";
    readonly output?: {
      readonly runtimeId: string;
      readonly executionId: string;
    };
    readonly error?: { readonly message: string };
  };
  type QueryResult = {
    readonly outcome: "success" | "error";
    readonly output?: {
      readonly rows: readonly { readonly kind: string }[];
    };
    readonly error?: { readonly message: string };
  };
  let entities: QueryResult = {
    outcome: "error",
    error: { message: "instrumented compatibility launch did not succeed" },
  };
  let state: QueryResult = entities;
  if (launch.outcome === "success" && launch.output !== undefined) {
    entities = (await input.runtime.invoke({
      schemaVersion: 1,
      toolCallId: `compatibility-query-entities.${randomUUID()}`,
      toolName: "game_query",
      input: {
        schemaVersion: 1,
        taskId: input.taskId,
        executionId: launch.output.executionId,
        select: "entities",
        limit: 200,
      },
    })) as QueryResult;
    state = (await input.runtime.invoke({
      schemaVersion: 1,
      toolCallId: `compatibility-query-state.${randomUUID()}`,
      toolName: "game_query",
      input: {
        schemaVersion: 1,
        taskId: input.taskId,
        executionId: launch.output.executionId,
        select: "state",
        limit: 200,
      },
    })) as QueryResult;
  }
  let stop:
    | {
        readonly outcome: "success";
        readonly output: {
          readonly cleanup: {
            readonly schemaVersion: 1;
            readonly processTreeTerminated: boolean;
            readonly runtimeExited: boolean;
            readonly bridgeExited: boolean;
            readonly isolationGroupEmpty: boolean;
            readonly scopeRemoved: boolean;
            readonly scratchRemoved: boolean;
            readonly storageReconciled: boolean;
          };
          readonly coverage: readonly {
            readonly schemaVersion: 1;
            readonly channelId: string;
            readonly status:
              "complete" | "sampled" | "incomplete" | "unavailable";
            readonly observedRecords: number;
            readonly droppedRecords: number;
            readonly overwrittenRecords: number;
            readonly limitations: readonly string[];
          }[];
          readonly loss: readonly unknown[];
        };
      }
    | {
        readonly outcome: "error";
        readonly error?: { readonly message: string };
      };
  if (launch.outcome === "success" && launch.output !== undefined) {
    stop = (await input.runtime.invoke({
      schemaVersion: 1,
      toolCallId: `compatibility-stop.${randomUUID()}`,
      toolName: "game_stop",
      input: {
        schemaVersion: 1,
        taskId: input.taskId,
        runtimeId: launch.output.runtimeId,
      },
    })) as typeof stop;
  } else {
    stop = {
      outcome: "error",
      ...(launch.error === undefined ? {} : { error: launch.error }),
    };
  }
  const cleanup =
    stop.outcome === "success"
      ? stop.output.cleanup
      : {
          schemaVersion: 1 as const,
          processTreeTerminated: false,
          runtimeExited: false,
          bridgeExited: false,
          isolationGroupEmpty: false,
          scopeRemoved: false,
          scratchRemoved: false,
          storageReconciled: false,
        };
  const coverage = stop.outcome === "success" ? stop.output.coverage : [];
  const failures = [
    ...(launch.outcome === "success"
      ? []
      : [launch.error?.message ?? "instrumented compatibility launch failed"]),
    ...(stop.outcome === "success"
      ? []
      : [stop.error?.message ?? "instrumented compatibility cleanup failed"]),
    ...(entities.outcome === "success" &&
    entities.output !== undefined &&
    entities.output.rows.some((row) => row.kind === "entity")
      ? []
      : [
          entities.error?.message ??
            "instrumented compatibility entity query returned no entity rows",
        ]),
    ...(state.outcome === "success" &&
    state.output !== undefined &&
    state.output.rows.some((row) => row.kind === "state")
      ? []
      : [
          state.error?.message ??
            "instrumented compatibility state query returned no state rows",
        ]),
    ...(Object.values(cleanup)
      .filter((value) => typeof value === "boolean")
      .every((value) => value)
      ? []
      : ["instrumented compatibility cleanup was incomplete"]),
    ...(coverage.length > 0 &&
    coverage.every(
      (entry) =>
        entry.status === "complete" &&
        entry.observedRecords > 0 &&
        entry.droppedRecords === 0 &&
        entry.overwrittenRecords === 0,
    ) &&
    (stop.outcome !== "success" || stop.output.loss.length === 0)
      ? []
      : ["instrumented compatibility observation coverage was incomplete"]),
  ];
  const content = {
    schemaVersion: 1 as const,
    taskId: input.taskId,
    buildId: input.buildId,
    sourceId: input.buildSourceId,
    environmentRevisionId: input.revision.environmentRevisionId,
    adapterRevisionId: input.adapterRevision.adapterRevisionId,
    toolchainReceiptId: input.toolchainReceiptId,
    bridgeHandshakeObserved: launch.outcome === "success",
    instrumentedLaunchObserved: launch.outcome === "success",
    queryObservations: {
      schemaVersion: 1 as const,
      entityQueryObserved: entities.outcome === "success",
      stateQueryObserved: state.outcome === "success",
      entityRows:
        entities.output?.rows.filter((row) => row.kind === "entity").length ??
        0,
      stateRows:
        state.output?.rows.filter((row) => row.kind === "state").length ?? 0,
    },
    coverage,
    capabilitySet: input.adapterRevision.capabilitySet,
    cleanup,
    outcome:
      failures.length === 0
        ? ("compatible" as const)
        : ("incompatible" as const),
    failures,
    observedAt: (input.now ?? (() => new Date().toISOString()))(),
  };
  const receipt = AdapterCompatibilityReceiptV1Schema.parse({
    ...content,
    receiptId: asAdapterCompatibilityReceiptId(
      `compatibility:v1:${hash(content)}`,
    ),
  });
  await input.taskStore.putCompatibilityReceiptOnce(receipt);
  return receipt;
}
