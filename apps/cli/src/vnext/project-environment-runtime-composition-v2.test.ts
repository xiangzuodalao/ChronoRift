import { describe, expect, it, vi } from "vitest";

import {
  asAdapterId,
  asBuildId,
  asEnvironmentBindingEpochId,
  asProjectAdapterRevisionId,
  asProjectEnvironmentId,
  asProjectEnvironmentRevisionId,
  asProjectEnvironmentTaskId,
  asProjectToolchainReceiptId,
  asSha256DigestV1,
  asSourceId,
  asWorkspaceId,
  type ProjectAdapterRevisionV1,
  type ProjectEnvironmentRevisionV1,
} from "@chronorift/domain";
import type { ProjectEnvironmentTaskStoreV1 } from "@chronorift/json-artifacts";

import type { PreparedProjectEnvironmentGodotBuildV1 } from "./candidate-godot-build.js";
import type { ProjectEnvironmentGameRuntimeV2 } from "./project-environment-game-runtime-v2.js";

const mocks = vi.hoisted(() => ({
  smoke: vi.fn(async () => ({
    receiptId: "compatibility:runtime-composition-v2",
    launchTargetId: "main",
    outcome: "compatible",
    failures: [],
  })),
}));

vi.mock("./project-environment-compatibility-v2.js", () => ({
  runProjectEnvironmentCompatibilitySmokeV2: mocks.smoke,
}));

import { composeProjectEnvironmentCompatibleRuntimeV2 } from "./project-environment-runtime-composition-v2.js";

const sha = (character: string) => asSha256DigestV1(character.repeat(64));

const fixture = () => {
  const taskId = asProjectEnvironmentTaskId("task:runtime-composition-v2");
  const environmentRevisionId = asProjectEnvironmentRevisionId(
    "environment-revision:runtime-composition-v2",
  );
  const adapterRevisionId = asProjectAdapterRevisionId(
    "adapter-revision:runtime-composition-v2",
  );
  const toolchainReceiptId = asProjectToolchainReceiptId(
    "toolchain:runtime-composition-v2",
  );
  const revision = {
    environmentId: asProjectEnvironmentId("environment:runtime-composition-v2"),
    environmentRevisionId,
    adapterRevisionId,
  } as ProjectEnvironmentRevisionV1;
  const adapterRevision = {
    adapterId: asAdapterId("adapter.runtime-composition-v2"),
    adapterRevisionId,
  } as ProjectAdapterRevisionV1;
  const buildId = asBuildId(`build:${sha("a")}`);
  const sourceId = asSourceId(`source:${sha("b")}`);
  const prepared = {
    build: {
      schemaVersion: 1,
      taskId,
      workspaceId: asWorkspaceId("workspace:runtime-composition-v2"),
      sourceId,
      buildId,
      sourceHash: sha("b"),
    },
    binding: {
      schemaVersion: 1,
      taskId,
      workspaceId: asWorkspaceId("workspace:runtime-composition-v2"),
      sourceId,
      buildId,
      environmentRevisionId,
      adapterRevisionId,
      bindingEpochId: asEnvironmentBindingEpochId(
        "binding:runtime-composition-v2",
      ),
      payloadSchemaDigest: sha("c"),
      sdkDigest: sha("d"),
      bridgeDigest: sha("e"),
      toolchainReceiptId,
      compatibilityStatus: "pending",
      compatibilityReceiptId: null,
      createdAt: "2026-08-13T00:00:00.000Z",
    },
    configuredMainScene: "res://main.tscn",
  } as PreparedProjectEnvironmentGodotBuildV1;
  return {
    taskId,
    environmentRevisionId,
    adapterRevisionId,
    toolchainReceiptId,
    revision,
    adapterRevision,
    buildId,
    prepared,
  };
};

const runtimeHarness = () => {
  const roles: string[] = [];
  const resolvers: (undefined | (() => Promise<unknown>))[] = [];
  const createRuntime = vi.fn(
    (_, role: string, resolve?: () => Promise<unknown>) => {
      roles.push(role);
      resolvers.push(resolve);
      return {
        close: vi.fn(async () => undefined),
      } as unknown as ProjectEnvironmentGameRuntimeV2;
    },
  );
  return { createRuntime, roles, resolvers };
};

describe("Project Environment V2 runtime composition", () => {
  it("labels compatibility smoke and ordinary runtimes explicitly", async () => {
    mocks.smoke.mockClear();
    const value = fixture();
    const runtimes = runtimeHarness();
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const taskStore = {
      readBuildBinding: vi.fn(async () => Promise.reject(missing)),
      putBuildOnce: vi.fn(async () => undefined),
      putBuildBindingOnce: vi.fn(async () => undefined),
    } as unknown as ProjectEnvironmentTaskStoreV1;

    const result = await composeProjectEnvironmentCompatibleRuntimeV2({
      taskStore,
      taskId: value.taskId,
      revision: value.revision,
      adapterRevision: value.adapterRevision,
      toolchainReceiptId: value.toolchainReceiptId,
      launchTargetId: "main",
      prepareBuild: async () => value.prepared,
      createRuntime: runtimes.createRuntime,
    }).resolve();

    expect(result.build.buildId).toBe(value.buildId);
    expect(runtimes.roles).toEqual(["compatibility_smoke", "ordinary"]);
    expect(runtimes.resolvers[0]).toBeUndefined();
    expect(runtimes.resolvers[1]).toBeTypeOf("function");
    expect(mocks.smoke).toHaveBeenCalledOnce();
    expect(mocks.smoke).toHaveBeenCalledWith(
      expect.objectContaining({ launchTargetId: "main" }),
    );
  });

  it("reuses a stored compatible receipt for the exact launch target", async () => {
    mocks.smoke.mockClear();
    const value = fixture();
    const runtimes = runtimeHarness();
    const taskStore = {
      readBuildBinding: vi.fn(async () => ({
        compatibilityStatus: "compatible",
        compatibilityReceiptId: "compatibility:runtime-composition-v2",
      })),
      readCompatibilityReceiptV2: vi.fn(async () => ({
        outcome: "compatible",
        buildId: value.buildId,
        environmentRevisionId: value.environmentRevisionId,
        launchTargetId: "secondary",
      })),
    } as unknown as ProjectEnvironmentTaskStoreV1;

    const result = await composeProjectEnvironmentCompatibleRuntimeV2({
      taskStore,
      taskId: value.taskId,
      revision: value.revision,
      adapterRevision: value.adapterRevision,
      toolchainReceiptId: value.toolchainReceiptId,
      launchTargetId: "secondary",
      prepareBuild: async () => value.prepared,
      createRuntime: runtimes.createRuntime,
    }).resolve();

    expect(result.build.buildId).toBe(value.buildId);
    expect(runtimes.roles).toEqual(["ordinary"]);
    expect(mocks.smoke).not.toHaveBeenCalled();
  });

  it("rejects reuse when a stored Build receipt belongs to another launch target", async () => {
    mocks.smoke.mockClear();
    const value = fixture();
    const runtimes = runtimeHarness();
    const taskStore = {
      readBuildBinding: vi.fn(async () => ({
        compatibilityStatus: "compatible",
        compatibilityReceiptId: "compatibility:runtime-composition-v2",
      })),
      readCompatibilityReceiptV2: vi.fn(async () => ({
        outcome: "compatible",
        buildId: value.buildId,
        environmentRevisionId: value.environmentRevisionId,
        launchTargetId: "main",
      })),
    } as unknown as ProjectEnvironmentTaskStoreV1;

    await expect(
      composeProjectEnvironmentCompatibleRuntimeV2({
        taskStore,
        taskId: value.taskId,
        revision: value.revision,
        adapterRevision: value.adapterRevision,
        toolchainReceiptId: value.toolchainReceiptId,
        launchTargetId: "secondary",
        prepareBuild: async () => value.prepared,
        createRuntime: runtimes.createRuntime,
      }).resolve(),
    ).rejects.toThrow(/crossed its Build binding/u);
    expect(runtimes.createRuntime).not.toHaveBeenCalled();
    expect(mocks.smoke).not.toHaveBeenCalled();
  });
});
