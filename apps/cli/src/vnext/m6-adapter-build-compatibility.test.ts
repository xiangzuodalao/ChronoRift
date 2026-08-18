import { describe, expect, it, vi } from "vitest";

import {
  PROJECT_CAPABILITY_MODULE_NAMES_V1,
  ProjectAdapterRevisionV1Schema,
  VNextBuildV1Schema,
} from "@chronorift/domain";

import {
  createM6AdapterBuildCompatibilityLineageV1,
  runM6AdapterBuildCompatibilityV1,
} from "./m6-adapter-build-compatibility.js";
import type { ProjectEnvironmentGameRuntimeV1 } from "./project-environment-game-runtime.js";

const sha = (character: string): string => character.repeat(64);

const adapterRevision = ProjectAdapterRevisionV1Schema.parse({
  schemaVersion: 1,
  adapterRevisionId: "adapter-revision:m6:pristine",
  adapterId: "adapter:m6",
  sourceId: "source:v1:pristine",
  packageDigest: sha("1"),
  manifestDigest: sha("2"),
  implementationDigest: sha("3"),
  payloadSchemaDigest: sha("4"),
  sdkDigest: sha("5"),
  bridgeDigest: sha("6"),
  capabilitySet: {
    schemaVersion: 1,
    modules: PROJECT_CAPABILITY_MODULE_NAMES_V1.map((module) => ({
      schemaVersion: 1,
      module,
      status: "implemented",
      protocolVersion: "project-environment-v1",
      limitations: [],
    })),
  },
  conformanceReceiptId: "conformance:m6:pristine",
  contentByteLength: 100,
  contentFileCount: 2,
});

const baselineHash = sha("b");
const build = VNextBuildV1Schema.parse({
  schemaVersion: 1,
  taskId: "task:m6",
  workspaceId: "workspace:m6",
  sourceId: `source:${baselineHash}`,
  buildId: "build:m6:mutant",
  sourceHash: baselineHash,
  workspaceDiffHash: sha("7"),
  buildConfigurationHash: sha("8"),
  outputHash: sha("9"),
  createdAt: "2026-08-14T00:00:00.000Z",
});

const lineage = () =>
  createM6AdapterBuildCompatibilityLineageV1({
    adapterRevision,
    build,
    baselineSourceHash: baselineHash,
    buildRole: "assignment_baseline",
    toolchainReceiptId: "toolchain:m6",
    toolchainArtifactDigest: sha("a"),
  });

const runtimeHarness = (
  options: {
    readonly crossedBuild?: boolean;
    readonly crossedSdk?: boolean;
    readonly launchFailure?: boolean;
  } = {},
) => {
  const calls: string[] = [];
  const close = vi.fn(async () => undefined);
  const adapterBuildCompatibilityIdentity = vi.fn(() => ({
    schemaVersion: 1 as const,
    taskId: build.taskId,
    buildId: build.buildId,
    sourceClosureId: build.sourceId,
    candidateSourceHash: build.sourceHash,
    adapterRevisionId: adapterRevision.adapterRevisionId,
    adapterPackageSha256: adapterRevision.packageDigest,
    adapterManifestSha256: adapterRevision.manifestDigest,
    sdkSha256:
      options.crossedSdk === true ? sha("f") : adapterRevision.sdkDigest,
    bridgeSha256: adapterRevision.bridgeDigest,
    toolchainSha256: sha("a"),
  }));
  const invoke = vi.fn(async (request: { readonly toolName: string }) => {
    calls.push(request.toolName);
    switch (request.toolName) {
      case "game_launch":
        if (options.launchFailure === true) {
          return {
            schemaVersion: 1,
            toolCallId: "m6-compatibility-launch",
            outcome: "error",
            error: {
              code: "runtime_launch_failed",
              message: "mutant Build did not launch",
              recoverable: false,
            },
          };
        }
        return {
          schemaVersion: 1,
          toolCallId: "m6-compatibility-launch",
          outcome: "success",
          output: {
            schemaVersion: 1,
            taskId: build.taskId,
            runtimeId: "runtime:m6",
            executionId: "execution:m6",
            buildId: options.crossedBuild ? "build:other" : build.buildId,
            environmentRevisionId: "environment-revision:pristine-provenance",
            adapterRevisionId: adapterRevision.adapterRevisionId,
          },
        };
      case "game_query":
        return {
          schemaVersion: 1,
          toolCallId: "m6-query",
          outcome: "success",
          output: {
            schemaVersion: 1,
            taskId: build.taskId,
            executionId: "execution:m6",
            rows: [
              {
                kind:
                  calls.filter((call) => call === "game_query").length === 1
                    ? "entity"
                    : "state",
              },
            ],
          },
        };
      case "game_stop":
        return {
          schemaVersion: 1,
          toolCallId: "m6-stop",
          outcome: "success",
          output: {
            schemaVersion: 1,
            taskId: build.taskId,
            runtimeId: "runtime:m6",
            executionId: "execution:m6",
            status: "stopped",
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
            loss: [],
            limitations: [],
          },
        };
      default:
        throw new Error(`unexpected tool ${request.toolName}`);
    }
  });
  return {
    calls,
    close,
    runtime: {
      adapterBuildCompatibilityIdentity,
      invoke,
      close,
    } as unknown as Pick<
      ProjectEnvironmentGameRuntimeV1,
      "adapterBuildCompatibilityIdentity" | "invoke" | "close"
    >,
  };
};

describe("M6 adapter-build compatibility composition", () => {
  it("smokes the exact mutant Build and emits no EnvironmentRevision identity", async () => {
    const harness = runtimeHarness();
    const times = ["2026-08-14T00:00:01.000Z", "2026-08-14T00:00:02.000Z"];
    const result = await runM6AdapterBuildCompatibilityV1({
      lineage: lineage(),
      runtime: harness.runtime,
      launchTargetId: "main",
      now: () => times.shift() ?? "2026-08-14T00:00:02.000Z",
    });

    expect(result.receipt.outcome).toBe("compatible");
    expect(result.binding.compatibilityStatus).toBe("compatible");
    expect(result.binding.lineage.adapterRevision.sourceId).toBe(
      "source:v1:pristine",
    );
    expect(result.binding.lineage.build.sourceId).toBe(
      `source:${baselineHash}`,
    );
    expect(JSON.stringify(result)).not.toContain("environmentRevisionId");
    expect(harness.calls).toEqual([
      "game_launch",
      "game_query",
      "game_query",
      "game_stop",
    ]);
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("rejects a runtime result that crosses the exact Build binding", async () => {
    const harness = runtimeHarness({ crossedBuild: true });
    await expect(
      runM6AdapterBuildCompatibilityV1({
        lineage: lineage(),
        runtime: harness.runtime,
        launchTargetId: "main",
        now: () => "2026-08-14T00:00:01.000Z",
      }),
    ).rejects.toThrow(/crossed.*Build/u);
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("rejects a runtime closure that crosses SDK lineage before launch", async () => {
    const harness = runtimeHarness({ crossedSdk: true });
    await expect(
      runM6AdapterBuildCompatibilityV1({
        lineage: lineage(),
        runtime: harness.runtime,
        launchTargetId: "main",
        now: () => "2026-08-14T00:00:01.000Z",
      }),
    ).rejects.toThrow(/SDK.*lineage/u);
    expect(harness.calls).toEqual([]);
    expect(harness.close).not.toHaveBeenCalled();
  });

  it("seals an incompatible result instead of inventing compatibility", async () => {
    const harness = runtimeHarness({ launchFailure: true });
    const result = await runM6AdapterBuildCompatibilityV1({
      lineage: lineage(),
      runtime: harness.runtime,
      launchTargetId: "main",
      now: () => "2026-08-14T00:00:01.000Z",
    });

    expect(result.receipt.outcome).toBe("incompatible");
    expect(result.binding.compatibilityStatus).toBe("incompatible");
    expect(result.receipt.failures).toContain("mutant Build did not launch");
    expect(harness.calls).toEqual(["game_launch"]);
    expect(harness.close).toHaveBeenCalledOnce();
  });
});
