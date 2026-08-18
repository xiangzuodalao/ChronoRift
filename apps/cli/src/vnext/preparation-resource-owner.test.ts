import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SandboxBrokerSetupCleanupError } from "./sandbox-broker.js";
import type { ProjectEnvironmentTaskDirectoryLayout } from "./task-paths.js";
import { ProjectEnvironmentPreparationResourceOwnerV1 } from "./preparation-resource-owner.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const createLayout = async () => {
  const parent = await mkdtemp(join(tmpdir(), "chronorift-preparation-owner-"));
  roots.push(parent);
  const taskRootDirectory = join(parent, "task");
  const children = {
    taskRecordDirectory: "records",
    runtimeRecordDirectory: "runtime-records",
    workspaceDirectory: "workspace",
    sandboxTemporaryDirectory: "tmp",
    sandboxArtifactScratchDirectory: "artifacts",
    piSessionDirectory: "pi",
    hostBaselineGitDirectory: "baseline",
    hostOperationTemporaryDirectory: "host-tmp",
    projectEnvironmentRecordDirectory: "project-records",
  } as const;
  await Promise.all(
    Object.values(children).map((child) =>
      mkdir(join(taskRootDirectory, child), { recursive: true, mode: 0o700 }),
    ),
  );
  return {
    taskRootDirectory,
    ...Object.fromEntries(
      Object.entries(children).map(([name, child]) => [
        name,
        join(taskRootDirectory, child),
      ]),
    ),
  } as ProjectEnvironmentTaskDirectoryLayout;
};

describe("ProjectEnvironmentPreparationResourceOwnerV1", () => {
  it("removes an owned Task root when preparation fails before broker creation", async () => {
    const layout = await createLayout();
    const owner = new ProjectEnvironmentPreparationResourceOwnerV1(layout);

    await expect(owner.cleanupAfterFailure()).resolves.toMatchObject({
      sandboxCleanupRequired: false,
      taskRootRemoved: true,
      cleanupProven: true,
    });
    await expect(lstat(layout.taskRootDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("cleans an adopted broker before removing the Task root", async () => {
    const layout = await createLayout();
    const owner = new ProjectEnvironmentPreparationResourceOwnerV1(layout);
    const cleanup = vi.fn(async () => ({
      schemaVersion: 1 as const,
      processGroupTerminated: true,
      cgroupPopulated: false,
      termSent: false,
      killSent: false,
      scopeRemoved: true,
      storageReconciled: true,
    }));
    owner.adoptBroker({ cleanup } as never);

    const [first, second] = await Promise.all([
      owner.cleanupAfterFailure(),
      owner.cleanupAfterFailure(),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      sandboxCleanupAttempted: true,
      sandboxCleanupReceiptObserved: true,
      sandboxCleanupComplete: true,
      taskRootRemoved: true,
      cleanupProven: true,
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("retains the Task root when broker cleanup cannot be proven", async () => {
    const layout = await createLayout();
    const owner = new ProjectEnvironmentPreparationResourceOwnerV1(layout);
    owner.adoptBroker({
      cleanup: vi.fn(async () => ({
        schemaVersion: 1,
        processGroupTerminated: false,
        cgroupPopulated: true,
        termSent: true,
        killSent: true,
        scopeRemoved: false,
        storageReconciled: false,
      })),
    } as never);

    await expect(owner.cleanupAfterFailure()).resolves.toMatchObject({
      sandboxCleanupComplete: false,
      taskRootRemovalAttempted: false,
      cleanupProven: false,
    });
    await expect(lstat(layout.taskRootDirectory)).resolves.toMatchObject({});
  });

  it("takes over retryable cleanup when broker setup fails before returning a broker", async () => {
    const layout = await createLayout();
    const owner = new ProjectEnvironmentPreparationResourceOwnerV1(layout);
    const retryCleanup = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("still busy"))
      .mockResolvedValueOnce(undefined);
    const setupFailure = new SandboxBrokerSetupCleanupError(
      new Error("setup failed"),
      new Error("initial cleanup failed"),
      retryCleanup,
    );

    expect(owner.adoptBrokerSetupCleanupFailure(setupFailure)).toBe(true);
    await expect(owner.cleanupAfterFailure()).resolves.toMatchObject({
      sandboxCleanupKind: "broker_setup",
      sandboxCleanupRequired: true,
      sandboxCleanupAttempted: true,
      sandboxCleanupReceiptObserved: false,
      sandboxCleanupComplete: true,
      taskRootRemoved: true,
      cleanupProven: true,
    });
    expect(retryCleanup).toHaveBeenCalledTimes(2);
  });

  it("retains the Task root when broker setup cleanup debt remains", async () => {
    const layout = await createLayout();
    const owner = new ProjectEnvironmentPreparationResourceOwnerV1(layout);
    const retryCleanup = vi.fn(async () => {
      throw new Error("still busy");
    });
    owner.adoptBrokerSetupCleanupFailure(
      new SandboxBrokerSetupCleanupError(
        new Error("setup failed"),
        new Error("initial cleanup failed"),
        retryCleanup,
      ),
    );

    await expect(owner.cleanupAfterFailure()).resolves.toMatchObject({
      sandboxCleanupKind: "broker_setup",
      sandboxCleanupComplete: false,
      taskRootRemovalAttempted: false,
      cleanupProven: false,
    });
    expect(retryCleanup).toHaveBeenCalledTimes(3);
    await expect(lstat(layout.taskRootDirectory)).resolves.toMatchObject({});
  });
});
