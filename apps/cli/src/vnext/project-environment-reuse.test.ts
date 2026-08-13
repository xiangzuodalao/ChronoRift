import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AdapterCompatibilityReceiptV1Schema,
  PROJECT_CAPABILITY_MODULE_NAMES_V1,
  PROJECT_READY_REQUIRED_MODULE_NAMES_V1,
  ProjectAdapterRevisionV1Schema,
  ProjectEnvironmentRevisionV1Schema,
  ProjectTurnBudgetV1Schema,
  ProjectTurnUsageV1Schema,
  asAdapterCompatibilityReceiptId,
  asAdapterConformanceReceiptId,
  asAdapterId,
  asBuildId,
  asEnvironmentBindingEpochId,
  asObserverEffectReceiptId,
  asProjectAdapterRevisionId,
  asProjectEnvironmentId,
  asProjectEnvironmentOperationId,
  asProjectEnvironmentReuseReceiptId,
  asProjectEnvironmentRevisionId,
  asProjectEnvironmentTaskId,
  asProjectEnvironmentTurnId,
  asProjectSessionId,
  asProjectToolchainReceiptId,
  asSha256DigestV1,
  asSourceId,
} from "@chronorift/domain";
import {
  ProjectEnvironmentTaskStoreV1,
  projectEnvironmentPackageContentDigestV1,
} from "@chronorift/json-artifacts";

import {
  bindReusableProjectEnvironmentRevisionV1,
  runReusedProjectEnvironmentGoalV1,
} from "./project-environment-reuse.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const digest = (character: string) => asSha256DigestV1(character.repeat(64));
const taskId = asProjectEnvironmentTaskId("task:reuse");
const sessionId = asProjectSessionId("session:reuse");
const bindingEpochId = asEnvironmentBindingEpochId("binding:reuse");
const sourceId = asSourceId("source:published");
const buildSourceId = asSourceId("source:build");
const toolchainReceiptId = asProjectToolchainReceiptId("toolchain:reuse");
const adapterRevisionId = asProjectAdapterRevisionId("adapter:revision:reuse");
const environmentRevisionId = asProjectEnvironmentRevisionId(
  "environment:revision:reuse",
);
const capabilitySet = {
  schemaVersion: 1 as const,
  modules: PROJECT_CAPABILITY_MODULE_NAMES_V1.map((module) => {
    const required = PROJECT_READY_REQUIRED_MODULE_NAMES_V1.includes(
      module as (typeof PROJECT_READY_REQUIRED_MODULE_NAMES_V1)[number],
    );
    return {
      schemaVersion: 1 as const,
      module,
      status: required ? ("implemented" as const) : ("unsupported" as const),
      protocolVersion: required ? "module:v1" : null,
      limitations: required ? [] : ["not exposed"],
    };
  }),
};
const files = [{ path: "adapter/manifest.json", bytes: Buffer.from("{}") }];
const revision = ProjectEnvironmentRevisionV1Schema.parse({
  schemaVersion: 1,
  environmentId: asProjectEnvironmentId("environment:reuse"),
  environmentRevisionId,
  sourceId,
  adapterRevisionId,
  sdkDigest: digest("a"),
  bridgeDigest: digest("b"),
  toolchainReceiptId,
  conformanceReceiptId: asAdapterConformanceReceiptId("conformance:reuse"),
  observerEffectReceiptId: asObserverEffectReceiptId("observer:reuse"),
  policyProfileDigest: digest("c"),
  publicationOperationId: asProjectEnvironmentOperationId("publication:reuse"),
  contentDigest: projectEnvironmentPackageContentDigestV1(files),
  publishedAt: "2026-08-13T00:00:00.000Z",
});
ProjectAdapterRevisionV1Schema.parse({
  schemaVersion: 1,
  adapterRevisionId,
  adapterId: asAdapterId("adapter:reuse"),
  sourceId,
  packageDigest: digest("d"),
  manifestDigest: digest("e"),
  implementationDigest: digest("f"),
  payloadSchemaDigest: digest("1"),
  sdkDigest: revision.sdkDigest,
  bridgeDigest: revision.bridgeDigest,
  capabilitySet,
  conformanceReceiptId: revision.conformanceReceiptId,
  contentByteLength: 1,
  contentFileCount: 1,
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
const compatibility = AdapterCompatibilityReceiptV1Schema.parse({
  schemaVersion: 1,
  receiptId: asAdapterCompatibilityReceiptId("compatibility:reuse"),
  taskId,
  buildId: asBuildId("build:reuse"),
  sourceId: buildSourceId,
  environmentRevisionId,
  adapterRevisionId,
  toolchainReceiptId,
  bridgeHandshakeObserved: true,
  instrumentedLaunchObserved: true,
  queryObservations: {
    schemaVersion: 1,
    entityQueryObserved: true,
    stateQueryObserved: true,
    entityRows: 1,
    stateRows: 1,
  },
  coverage: [
    {
      schemaVersion: 1,
      channelId: "project_adapter_observations",
      status: "complete",
      observedRecords: 2,
      droppedRecords: 0,
      overwrittenRecords: 0,
      limitations: [],
    },
  ],
  capabilitySet,
  cleanup,
  outcome: "compatible",
  failures: [],
  observedAt: "2026-08-13T00:01:00.000Z",
});

const setupStore = async () => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-pe-reuse-"));
  roots.push(root);
  await chmod(root, 0o700);
  const storeRoot = join(root, "store");
  await mkdir(storeRoot, { mode: 0o700 });
  const store = new ProjectEnvironmentTaskStoreV1({ storeRoot, taskId });
  await store.create();
  return store;
};

describe("Project Environment new-Task reuse", () => {
  it("persists an exact reuse receipt and reuse binding without an attempt", async () => {
    const store = await setupStore();
    await store.putCompatibilityReceiptOnce(compatibility);
    const result = await bindReusableProjectEnvironmentRevisionV1({
      taskStore: store,
      taskId,
      sessionId,
      bindingEpochId,
      revision,
      observedCurrentRevisionId: environmentRevisionId,
      compatibility,
      createdAt: compatibility.observedAt,
      boundAt: "2026-08-13T00:02:00.000Z",
    });
    expect(result.binding).toMatchObject({
      state: "reused",
      sessionId,
      reuseReceiptId: result.receipt.receiptId,
    });
    await expect(store.readBindingEpochs()).resolves.toEqual([result.binding]);
    await expect(
      store.readReuseReceipt(result.receipt.receiptId),
    ).resolves.toEqual(result.receipt);
    await expect(
      store.readInitializationAttempt(
        "attempt:does-not-exist" as Parameters<
          typeof store.readInitializationAttempt
        >[0],
      ),
    ).rejects.toThrow();
    expect(result.receipt.buildSourceId).toBe(buildSourceId);
    expect(result.receipt.receiptId).toBe(
      asProjectEnvironmentReuseReceiptId(result.receipt.receiptId),
    );
  });

  it("rejects current drift and does not append a binding", async () => {
    const store = await setupStore();
    await expect(
      bindReusableProjectEnvironmentRevisionV1({
        taskStore: store,
        taskId,
        sessionId,
        bindingEpochId,
        revision,
        observedCurrentRevisionId: asProjectEnvironmentRevisionId(
          "environment:revision:other",
        ),
        compatibility,
        createdAt: compatibility.observedAt,
        boundAt: "2026-08-13T00:02:00.000Z",
      }),
    ).rejects.toThrow(/current revision/u);
    await expect(store.readBindingEpochs()).resolves.toEqual([]);
  });

  it("starts only a user-goal turn in the new Session", async () => {
    const putTurn = vi.fn(async () => undefined);
    const runTurn = vi.fn(async () => ({
      status: "completed" as const,
      sessionId,
      usageStatus: "observed" as const,
      usage: ProjectTurnUsageV1Schema.parse({
        schemaVersion: 1,
        wallTimeMs: 1,
        toolCalls: 0,
        runtimeTimeMs: 0,
        inputTokens: 1,
        outputTokens: 1,
        storageBytes: 0,
        storageInodes: 0,
      }),
      errorCode: null,
      errorMessage: null,
    }));
    const result = await runReusedProjectEnvironmentGoalV1({
      taskId,
      sessionId,
      bindingEpochId,
      turnId: asProjectEnvironmentTurnId("turn:reuse:goal"),
      goal: "Inspect the project",
      budget: ProjectTurnBudgetV1Schema.parse({
        schemaVersion: 1,
        wallTimeMs: 1000,
        toolCallLimit: 10,
        runtimeTimeMs: 1000,
        tokenPolicy: "observe_only",
        tokenLimit: null,
        storageByteLimit: 1024,
        storageInodeLimit: 10,
      }),
      runTurn,
      putTurn,
      now: () => "2026-08-13T00:03:00.000Z",
    });
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "user_goal", bindingEpochId }),
    );
    expect(result.goalDelivered).toBe(true);
    expect(result.turn).toMatchObject({
      purpose: "user_goal",
      attemptId: null,
      sessionId,
    });
  });

  it("seals a thrown reused-goal Pi failure without fabricating usage", async () => {
    const putTurn = vi.fn(async () => undefined);
    const runTurn = vi.fn(async () => {
      throw Object.assign(new Error("provider request failed before stats"), {
        code: "provider_error_unknown",
      });
    });

    const result = await runReusedProjectEnvironmentGoalV1({
      taskId,
      sessionId,
      bindingEpochId,
      turnId: asProjectEnvironmentTurnId("turn:reuse:failed-goal"),
      goal: "Inspect the project",
      budget: ProjectTurnBudgetV1Schema.parse({
        schemaVersion: 1,
        wallTimeMs: 1000,
        toolCallLimit: 10,
        runtimeTimeMs: 1000,
        tokenPolicy: "observe_only",
        tokenLimit: null,
        storageByteLimit: 1024,
        storageInodeLimit: 10,
      }),
      runTurn,
      putTurn,
      now: () => "2026-08-13T00:03:00.000Z",
    });

    expect(result.goalDelivered).toBe(false);
    expect(result.turn).toMatchObject({
      status: "failed",
      usageStatus: "unavailable",
      usage: null,
      terminalCode: "provider_error_unknown",
      terminalMessage: "provider request failed before stats",
    });
    expect(putTurn).toHaveBeenCalledWith(result.turn);
  });
});
