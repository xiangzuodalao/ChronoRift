import { describe, expect, it, vi } from "vitest";

import {
  PROJECT_CAPABILITY_MODULE_NAMES_V1,
  ProjectCapabilitySetV1Schema,
  asAdapterId,
  asBuildId,
  asProjectAdapterRevisionId,
  asProjectEnvironmentId,
  asProjectEnvironmentRevisionId,
  asProjectEnvironmentTaskId,
  asProjectToolchainReceiptId,
  asSourceId,
  type AdapterCompatibilityReceiptV2,
  type ProjectAdapterRevisionV1,
  type ProjectEnvironmentRevisionV1,
} from "@chronorift/domain";
import type { ProjectEnvironmentTaskStoreV1 } from "@chronorift/json-artifacts";

import type { ProjectEnvironmentGameRuntimeV2 } from "./project-environment-game-runtime-v2.js";
import { runProjectEnvironmentCompatibilitySmokeV2 } from "./project-environment-compatibility-v2.js";

const capabilitySet = ProjectCapabilitySetV1Schema.parse({
  schemaVersion: 1,
  modules: PROJECT_CAPABILITY_MODULE_NAMES_V1.map((module) => ({
    schemaVersion: 1,
    module,
    status: "implemented",
    protocolVersion: "project-adapter-module:v2",
    limitations: [],
  })),
});
const cleanup = {
  schemaVersion: 1 as const,
  processTreeTerminated: true,
  runtimeExited: true,
  bridgeExited: true,
  isolationGroupEmpty: true,
  scopeRemoved: true,
  scratchRemoved: true,
  storageReconciled: true,
};
const coverage = [
  {
    schemaVersion: 1 as const,
    channelId: "project_adapter_observations_v2",
    status: "complete" as const,
    observedRecords: 9,
    droppedRecords: 0,
    overwrittenRecords: 0,
    limitations: [],
  },
];
const dynamicTraces = [
  {
    schemaVersion: 2 as const,
    traceId: "dynamic-trace.compatibility-v2",
    entityId: "entity.compatibility-v2",
    firstIncarnation: 1,
    lastIncarnation: 2,
    recordSequences: [0, 1, 2, 3, 4, 5, 6, 7, 8],
  },
];

const runtime = () =>
  ({
    lastDynamicTraces: dynamicTraces,
    invoke: vi.fn(
      async (request: {
        readonly toolName: string;
        readonly input: Readonly<Record<string, unknown>>;
      }) => {
        if (request.toolName === "game_launch")
          return {
            outcome: "success",
            output: {
              executionId: "execution.compatibility-v2",
              runtimeId: "runtime.compatibility-v2",
            },
          };
        if (request.toolName === "game_query") {
          const count =
            request.input.select === "entities"
              ? 3
              : request.input.select === "state"
                ? 4
                : 2;
          return {
            outcome: "success",
            output: { rows: Array.from({ length: count }, () => ({})) },
          };
        }
        if (request.toolName === "game_capture_pin")
          return {
            outcome: "success",
            output: { captureWindowId: "capture-window.compatibility-v2" },
          };
        if (request.toolName === "game_stop")
          return {
            outcome: "success",
            output: { cleanup, coverage },
          };
        return { outcome: "success", output: {} };
      },
    ),
  }) as unknown as ProjectEnvironmentGameRuntimeV2;

const taskId = asProjectEnvironmentTaskId("task:compatibility-v2-target");
const buildId = asBuildId(`build:${"1".repeat(64)}`);
const buildSourceId = asSourceId(`source:${"2".repeat(64)}`);
const environmentRevisionId = asProjectEnvironmentRevisionId(
  "environment-revision:compatibility-v2-target",
);
const adapterRevisionId = asProjectAdapterRevisionId(
  "adapter-revision:compatibility-v2-target",
);
const revision = {
  environmentId: asProjectEnvironmentId("environment:compatibility-v2-target"),
  environmentRevisionId,
} as ProjectEnvironmentRevisionV1;
const adapterRevision = {
  adapterId: asAdapterId("adapter.compatibility-v2-target"),
  adapterRevisionId,
  capabilitySet,
} as ProjectAdapterRevisionV1;
const toolchainReceiptId = asProjectToolchainReceiptId(
  "toolchain:compatibility-v2-target",
);

const smoke = async (launchTargetId: string) => {
  const persisted: AdapterCompatibilityReceiptV2[] = [];
  const taskStore = {
    putCompatibilityReceiptV2Once: vi.fn(
      async (receipt: AdapterCompatibilityReceiptV2) => {
        persisted.push(receipt);
      },
    ),
  } as unknown as ProjectEnvironmentTaskStoreV1;
  const gameRuntime = runtime();
  const receipt = await runProjectEnvironmentCompatibilitySmokeV2({
    runtime: gameRuntime,
    taskStore,
    taskId,
    buildId,
    buildSourceId,
    revision,
    adapterRevision,
    toolchainReceiptId,
    launchTargetId,
    now: () => "2026-08-14T00:00:00.000Z",
  });
  return { receipt, persisted, gameRuntime };
};

describe("Project Environment V2 compatibility smoke", () => {
  it("persists and commits the exact launch target into the receipt identity", async () => {
    const main = await smoke("main");
    const secondary = await smoke("secondary");

    expect(main.receipt).toMatchObject({
      launchTargetId: "main",
      outcome: "compatible",
    });
    expect(secondary.receipt.launchTargetId).toBe("secondary");
    expect(secondary.receipt.receiptId).not.toBe(main.receipt.receiptId);
    expect(main.persisted).toEqual([main.receipt]);
    expect(secondary.persisted).toEqual([secondary.receipt]);
    expect(main.receipt.sourceId).toBe(buildSourceId);
    expect(main.receipt.adapterRevisionId).toBe(adapterRevisionId);
    expect(main.receipt.receiptId).toMatch(/^compatibility:v2:[a-f0-9]{64}$/u);
  });
});
