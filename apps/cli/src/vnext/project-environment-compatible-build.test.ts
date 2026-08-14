import { describe, expect, it, vi } from "vitest";

import {
  AdapterCompatibilityReceiptV1Schema,
  PROJECT_CAPABILITY_MODULE_NAMES_V1,
  ProjectCapabilitySetV1Schema,
  asAdapterCompatibilityReceiptId,
  asAdapterConformanceReceiptId,
  asAdapterId,
  asBuildId,
  asEnvironmentBindingEpochId,
  asObserverEffectReceiptId,
  asProjectAdapterRevisionId,
  asProjectEnvironmentId,
  asProjectEnvironmentOperationId,
  asProjectEnvironmentRevisionId,
  asProjectEnvironmentTaskId,
  asProjectToolchainReceiptId,
  asSha256DigestV1,
  asSourceId,
  asWorkspaceId,
  type ProjectAdapterRevisionV1,
  type ProjectEnvironmentRevisionV1,
  type VNextBuildV1,
  type ProjectEnvironmentBuildBindingV1,
  type AdapterCompatibilityReceiptV1,
} from "@chronorift/domain";
import type { ProjectEnvironmentTaskStoreV1 } from "@chronorift/json-artifacts";

import type { PreparedProjectEnvironmentGodotBuildV1 } from "./candidate-godot-build.js";
import { ProjectEnvironmentCompatibleBuildResolverV1 } from "./project-environment-compatible-build.js";
import type { ProjectEnvironmentGameRuntimeV1 } from "./project-environment-game-runtime.js";
import type { runProjectEnvironmentCompatibilitySmokeV1 } from "./project-environment-compatibility.js";

type CompatibilitySmokeInputV1 = Parameters<
  typeof runProjectEnvironmentCompatibilitySmokeV1
>[0];

const sha = (character: string) => asSha256DigestV1(character.repeat(64));
const taskId = asProjectEnvironmentTaskId("task:compatible-build");
const toolchainReceiptId = asProjectToolchainReceiptId(
  "toolchain:compatible-build",
);
const environmentRevisionId = asProjectEnvironmentRevisionId(
  "environment-revision:compatible-build",
);
const adapterRevisionId = asProjectAdapterRevisionId(
  "adapter-revision:compatible-build",
);
const capabilitySet = ProjectCapabilitySetV1Schema.parse({
  schemaVersion: 1,
  modules: PROJECT_CAPABILITY_MODULE_NAMES_V1.map((module) => ({
    schemaVersion: 1,
    module,
    status: "implemented",
    protocolVersion: "project-environment-v1",
    limitations: [],
  })),
});
const adapterRevision = {
  schemaVersion: 1,
  adapterRevisionId,
  adapterId: asAdapterId("adapter.compatible-build"),
  sourceId: asSourceId("source:published"),
  packageDigest: sha("1"),
  manifestDigest: sha("2"),
  implementationDigest: sha("3"),
  payloadSchemaDigest: sha("4"),
  sdkDigest: sha("5"),
  bridgeDigest: sha("6"),
  capabilitySet,
  conformanceReceiptId: asAdapterConformanceReceiptId(
    "conformance:compatible-build",
  ),
  contentByteLength: 100,
  contentFileCount: 2,
} as ProjectAdapterRevisionV1;
const revision = {
  schemaVersion: 1,
  environmentId: asProjectEnvironmentId("environment:compatible-build"),
  environmentRevisionId,
  sourceId: adapterRevision.sourceId,
  adapterRevisionId,
  sdkDigest: adapterRevision.sdkDigest,
  bridgeDigest: adapterRevision.bridgeDigest,
  toolchainReceiptId,
  conformanceReceiptId: adapterRevision.conformanceReceiptId,
  observerEffectReceiptId: asObserverEffectReceiptId(
    "observer:compatible-build",
  ),
  policyProfileDigest: sha("7"),
  publicationOperationId: asProjectEnvironmentOperationId(
    "publication:compatible-build",
  ),
  contentDigest: sha("8"),
  publishedAt: "2026-08-13T00:00:00.000Z",
} as ProjectEnvironmentRevisionV1;

const prepared = (suffix: string): PreparedProjectEnvironmentGodotBuildV1 => {
  const sourceHash = sha(suffix);
  const sourceId = asSourceId(`source:${sourceHash}`);
  const buildId = asBuildId(`build:${sha(suffix === "a" ? "a" : "b")}`);
  return {
    build: {
      schemaVersion: 1,
      taskId,
      workspaceId: asWorkspaceId("workspace:compatible-build"),
      sourceId,
      buildId,
      sourceHash,
      workspaceDiffHash: sha("c"),
      buildConfigurationHash: sha("d"),
      outputHash: sha("e"),
      createdAt: "2026-08-13T00:00:01.000Z",
    },
    binding: {
      schemaVersion: 1,
      taskId,
      workspaceId: asWorkspaceId("workspace:compatible-build"),
      sourceId,
      buildId,
      bindingEpochId: asEnvironmentBindingEpochId("binding:compatible-build"),
      environmentRevisionId,
      adapterRevisionId,
      payloadSchemaDigest: adapterRevision.payloadSchemaDigest,
      sdkDigest: revision.sdkDigest,
      bridgeDigest: revision.bridgeDigest,
      toolchainReceiptId,
      compatibilityStatus: "pending",
      compatibilityReceiptId: null,
      createdAt: "2026-08-13T00:00:01.000Z",
    },
    configuredMainScene: "res://main.tscn",
    projectHash: sha("f"),
    fileCount: 2,
    byteLength: 100,
  };
};

const harness = () => {
  const builds = new Map<string, VNextBuildV1>();
  const bindings = new Map<string, ProjectEnvironmentBuildBindingV1>();
  const receipts = new Map<string, AdapterCompatibilityReceiptV1>();
  const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  const putBuildOnce = vi.fn(async (value: VNextBuildV1) => {
    builds.set(value.buildId, value);
  });
  const readBuild = vi.fn(async (id: VNextBuildV1["buildId"]) => {
    const value = builds.get(id);
    if (value === undefined) throw missing();
    return value;
  });
  const putBuildBindingOnce = vi.fn(
    async (value: ProjectEnvironmentBuildBindingV1) => {
      bindings.set(value.buildId, value);
    },
  );
  const readBuildBinding = vi.fn(
    async (id: ProjectEnvironmentBuildBindingV1["buildId"]) => {
      const value = bindings.get(id);
      if (value === undefined) throw missing();
      return value;
    },
  );
  const putCompatibilityReceiptOnce = vi.fn(
    async (value: AdapterCompatibilityReceiptV1) => {
      receipts.set(value.receiptId, value);
    },
  );
  const readCompatibilityReceipt = vi.fn(
    async (id: AdapterCompatibilityReceiptV1["receiptId"]) => {
      const value = receipts.get(id);
      if (value === undefined) throw missing();
      return value;
    },
  );
  const store = {
    taskId,
    putBuildOnce,
    readBuild,
    putBuildBindingOnce,
    readBuildBinding,
    putCompatibilityReceiptOnce,
    readCompatibilityReceipt,
  } as unknown as ProjectEnvironmentTaskStoreV1;
  const close = vi.fn(async () => undefined);
  const runtime = { close } as unknown as ProjectEnvironmentGameRuntimeV1;
  let smokeSequence = 0;
  const runSmoke: typeof runProjectEnvironmentCompatibilitySmokeV1 = vi.fn(
    async (input: CompatibilitySmokeInputV1) => {
      smokeSequence += 1;
      const receipt = AdapterCompatibilityReceiptV1Schema.parse({
        schemaVersion: 1,
        receiptId: asAdapterCompatibilityReceiptId(
          `compatibility:compatible-build:${smokeSequence}`,
        ),
        taskId,
        buildId: input.buildId,
        sourceId: input.buildSourceId,
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
        cleanup: {
          schemaVersion: 1,
          processTreeTerminated: true,
          runtimeExited: true,
          bridgeExited: true,
          isolationGroupEmpty: true,
          scopeRemoved: true,
          scratchRemoved: true,
          storageReconciled: true,
        },
        outcome: "compatible",
        failures: [],
        observedAt: "2026-08-13T00:00:02.000Z",
      });
      await store.putCompatibilityReceiptOnce(receipt);
      return receipt;
    },
  );
  return {
    store,
    runtime,
    close,
    runSmoke,
    putBuildOnce,
  };
};

describe("ProjectEnvironmentCompatibleBuildResolverV1", () => {
  it("smokes and persists each exact Build once while unchanged discovery is idempotent", async () => {
    const value = harness();
    let current = prepared("a");
    const prepareBuild = vi.fn(async () => current);
    const resolver = new ProjectEnvironmentCompatibleBuildResolverV1({
      taskStore: value.store,
      taskId,
      revision,
      adapterRevision,
      toolchainReceiptId,
      launchTargetId: "default",
      prepareBuild,
      createSmokeRuntime: () => value.runtime,
      runSmoke: value.runSmoke,
    });

    const first = await resolver.resolve();
    const unchanged = await resolver.resolve();
    expect(unchanged).toEqual(first);
    expect(value.runSmoke).toHaveBeenCalledTimes(1);
    expect(value.putBuildOnce).toHaveBeenCalledTimes(1);

    current = prepared("b");
    const edited = await resolver.resolve();
    expect(edited.buildId).not.toBe(first.buildId);
    expect(value.runSmoke).toHaveBeenCalledTimes(2);
    expect(value.putBuildOnce).toHaveBeenCalledTimes(2);
    expect(value.close).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent discovery of the same workspace", async () => {
    const value = harness();
    const resolver = new ProjectEnvironmentCompatibleBuildResolverV1({
      taskStore: value.store,
      taskId,
      revision,
      adapterRevision,
      toolchainReceiptId,
      launchTargetId: "default",
      prepareBuild: async () => prepared("a"),
      createSmokeRuntime: () => value.runtime,
      runSmoke: value.runSmoke,
    });
    const [left, right] = await Promise.all([
      resolver.resolve(),
      resolver.resolve(),
    ]);
    expect(right).toEqual(left);
    expect(value.runSmoke).toHaveBeenCalledTimes(1);
  });
});
