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
  type AdapterCompatibilityReceiptV1,
  type ProjectAdapterRevisionV1,
  type ProjectEnvironmentBuildBindingV1,
  type ProjectEnvironmentRevisionV1,
  type VNextBuildV1,
} from "@chronorift/domain";
import type { ProjectEnvironmentTaskStoreV1 } from "@chronorift/json-artifacts";

import type { PreparedProjectEnvironmentGodotBuildV1 } from "./candidate-godot-build.js";
import type {
  ProjectEnvironmentGameRuntimeV1,
  ProjectEnvironmentRuntimeBuildV1,
} from "./project-environment-game-runtime.js";
import type { runProjectEnvironmentCompatibilitySmokeV1 } from "./project-environment-compatibility.js";
import { composeProjectEnvironmentCompatibleRuntimeV1 } from "./project-environment-runtime-composition.js";

type CompatibilitySmokeInputV1 = Parameters<
  typeof runProjectEnvironmentCompatibilitySmokeV1
>[0];

const sha = (character: string) => asSha256DigestV1(character.repeat(64));
const taskId = asProjectEnvironmentTaskId("task:runtime-composition");
const toolchainReceiptId = asProjectToolchainReceiptId(
  "toolchain:runtime-composition",
);
const environmentRevisionId = asProjectEnvironmentRevisionId(
  "environment-revision:runtime-composition",
);
const adapterRevisionId = asProjectAdapterRevisionId(
  "adapter-revision:runtime-composition",
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
  adapterId: asAdapterId("adapter.runtime-composition"),
  sourceId: asSourceId("source:published"),
  packageDigest: sha("1"),
  manifestDigest: sha("2"),
  implementationDigest: sha("3"),
  payloadSchemaDigest: sha("4"),
  sdkDigest: sha("5"),
  bridgeDigest: sha("6"),
  capabilitySet,
  conformanceReceiptId: asAdapterConformanceReceiptId(
    "conformance:runtime-composition",
  ),
  contentByteLength: 100,
  contentFileCount: 2,
} as ProjectAdapterRevisionV1;
const revision = {
  schemaVersion: 1,
  environmentId: asProjectEnvironmentId("environment:runtime-composition"),
  environmentRevisionId,
  sourceId: adapterRevision.sourceId,
  adapterRevisionId,
  sdkDigest: adapterRevision.sdkDigest,
  bridgeDigest: adapterRevision.bridgeDigest,
  toolchainReceiptId,
  conformanceReceiptId: adapterRevision.conformanceReceiptId,
  observerEffectReceiptId: asObserverEffectReceiptId(
    "observer:runtime-composition",
  ),
  policyProfileDigest: sha("7"),
  publicationOperationId: asProjectEnvironmentOperationId(
    "publication:runtime-composition",
  ),
  contentDigest: sha("8"),
  publishedAt: "2026-08-13T00:00:00.000Z",
} as ProjectEnvironmentRevisionV1;

const prepared = (character: "a" | "b") => {
  const sourceHash = sha(character);
  const sourceId = asSourceId(`source:${sourceHash}`);
  const buildId = asBuildId(`build:${sha(character)}`);
  return {
    build: {
      schemaVersion: 1,
      taskId,
      workspaceId: asWorkspaceId("workspace:runtime-composition"),
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
      workspaceId: asWorkspaceId("workspace:runtime-composition"),
      sourceId,
      buildId,
      bindingEpochId: asEnvironmentBindingEpochId(
        "binding:runtime-composition",
      ),
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
  } satisfies PreparedProjectEnvironmentGodotBuildV1;
};

const harness = () => {
  const builds = new Map<string, VNextBuildV1>();
  const bindings = new Map<string, ProjectEnvironmentBuildBindingV1>();
  const receipts = new Map<string, AdapterCompatibilityReceiptV1>();
  const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  const store = {
    taskId,
    putBuildOnce: vi.fn(async (value: VNextBuildV1) => {
      builds.set(value.buildId, value);
    }),
    readBuild: vi.fn(async (id: VNextBuildV1["buildId"]) => {
      const value = builds.get(id);
      if (value === undefined) throw missing();
      return value;
    }),
    putBuildBindingOnce: vi.fn(
      async (value: ProjectEnvironmentBuildBindingV1) => {
        bindings.set(value.buildId, value);
      },
    ),
    readBuildBinding: vi.fn(
      async (id: ProjectEnvironmentBuildBindingV1["buildId"]) => {
        const value = bindings.get(id);
        if (value === undefined) throw missing();
        return value;
      },
    ),
    putCompatibilityReceiptOnce: vi.fn(
      async (value: AdapterCompatibilityReceiptV1) => {
        receipts.set(value.receiptId, value);
      },
    ),
    readCompatibilityReceipt: vi.fn(
      async (id: AdapterCompatibilityReceiptV1["receiptId"]) => {
        const value = receipts.get(id);
        if (value === undefined) throw missing();
        return value;
      },
    ),
  } as unknown as ProjectEnvironmentTaskStoreV1;
  let smokeSequence = 0;
  const runSmoke: typeof runProjectEnvironmentCompatibilitySmokeV1 = vi.fn(
    async (input: CompatibilitySmokeInputV1) => {
      smokeSequence += 1;
      const receipt = AdapterCompatibilityReceiptV1Schema.parse({
        schemaVersion: 1,
        receiptId: asAdapterCompatibilityReceiptId(
          `compatibility:runtime-composition:${smokeSequence}`,
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
  return { store, runSmoke };
};

describe("Project Environment Preview runtime composition", () => {
  it.each(["initial", "reuse"] as const)(
    "gives the long-lived %s runtime a resolver while smoke stays non-recursive",
    async () => {
      const value = harness();
      let current = prepared("a");
      const created: {
        readonly build: ProjectEnvironmentRuntimeBuildV1;
        readonly resolve?: () => Promise<ProjectEnvironmentRuntimeBuildV1>;
      }[] = [];
      const createRuntime = vi.fn(
        (
          build: ProjectEnvironmentRuntimeBuildV1,
          resolve?: () => Promise<ProjectEnvironmentRuntimeBuildV1>,
        ) => {
          created.push({
            build,
            ...(resolve === undefined ? {} : { resolve }),
          });
          return {
            close: vi.fn(async () => undefined),
          } as unknown as ProjectEnvironmentGameRuntimeV1;
        },
      );
      const onResolved = vi.fn();
      const composition = composeProjectEnvironmentCompatibleRuntimeV1({
        taskStore: value.store,
        taskId,
        revision,
        adapterRevision,
        toolchainReceiptId,
        launchTargetId: "main",
        prepareBuild: async () => current,
        createRuntime,
        runSmoke: value.runSmoke,
        onResolved,
      });

      const initial = await composition.resolve();
      expect(created).toHaveLength(2);
      expect(created[0]?.resolve).toBeUndefined();
      expect(created[1]?.resolve).toBeTypeOf("function");
      expect(initial.build.buildId).toBe(current.build.buildId);

      current = prepared("b");
      const edited = await created[1]?.resolve?.();
      expect(edited?.buildId).toBe(current.build.buildId);
      expect(edited?.buildId).not.toBe(initial.build.buildId);
      expect(created[2]?.resolve).toBeUndefined();
      expect(value.runSmoke).toHaveBeenCalledTimes(2);
      expect(onResolved).toHaveBeenNthCalledWith(1, initial.build);
      expect(onResolved).toHaveBeenNthCalledWith(2, edited);
    },
  );
});
