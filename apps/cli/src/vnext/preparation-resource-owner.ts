import { lstat, rm } from "node:fs/promises";

import type { SandboxCleanupReceiptV1 } from "./contracts.js";
import {
  SandboxBrokerSetupCleanupError,
  type DuplexTaskSandboxBrokerV1,
} from "./sandbox-broker.js";
import type { ProjectEnvironmentTaskDirectoryLayout } from "./task-paths.js";

interface OwnedDirectoryIdentityV1 {
  readonly dev: number;
  readonly ino: number;
}

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

const sandboxCleanupComplete = (receipt: SandboxCleanupReceiptV1): boolean =>
  receipt.processGroupTerminated &&
  !receipt.cgroupPopulated &&
  receipt.scopeRemoved &&
  receipt.storageReconciled === true;

export interface ProjectEnvironmentPreparationCleanupTruthV1 {
  readonly schemaVersion: 1;
  readonly sandboxCleanupKind: "none" | "broker_setup" | "broker";
  readonly sandboxCleanupRequired: boolean;
  readonly sandboxCleanupAttempted: boolean;
  readonly sandboxCleanupReceiptObserved: boolean;
  readonly sandboxCleanupComplete: boolean;
  readonly taskRootRemovalAttempted: boolean;
  readonly taskRootRemoved: boolean;
  readonly cleanupProven: boolean;
}

/**
 * Owns a newly-created Task root from the first synchronous instruction after
 * layout creation. The identity observation starts in the constructor, so a
 * later preparation failure cannot lose the only safe cleanup target while an
 * asynchronous validation is in flight.
 */
export class ProjectEnvironmentPreparationResourceOwnerV1 {
  readonly #identity: Promise<OwnedDirectoryIdentityV1>;
  #broker: DuplexTaskSandboxBrokerV1 | undefined;
  #brokerSetupCleanup: (() => Promise<void>) | undefined;
  #released = false;
  #cleanup: Promise<ProjectEnvironmentPreparationCleanupTruthV1> | undefined;

  public constructor(
    private readonly layout: ProjectEnvironmentTaskDirectoryLayout,
  ) {
    this.#identity = lstat(layout.taskRootDirectory).then((metadata) => {
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("prepared Task root is not a real directory");
      }
      return { dev: metadata.dev, ino: metadata.ino };
    });
    void this.#identity.catch(() => undefined);
  }

  public adoptBroker(broker: DuplexTaskSandboxBrokerV1): void {
    if (
      this.#released ||
      this.#cleanup !== undefined ||
      this.#broker !== undefined
    ) {
      throw new Error("preparation resource owner cannot adopt this broker");
    }
    this.#broker = broker;
  }

  /**
   * Transfers the retryable cleanup owner exported by the broker factory when
   * that factory acquired resources but could not return a broker.
   */
  public adoptBrokerSetupCleanupFailure(error: unknown): boolean {
    if (!(error instanceof SandboxBrokerSetupCleanupError)) return false;
    if (
      this.#released ||
      this.#cleanup !== undefined ||
      this.#broker !== undefined ||
      this.#brokerSetupCleanup !== undefined
    ) {
      throw new Error(
        "preparation resource owner cannot adopt broker setup cleanup",
      );
    }
    this.#brokerSetupCleanup = () => error.retryCleanup();
    return true;
  }

  public release(): void {
    if (this.#cleanup !== undefined) {
      throw new Error("preparation resources are already being cleaned");
    }
    this.#released = true;
  }

  public cleanupAfterFailure(): Promise<ProjectEnvironmentPreparationCleanupTruthV1> {
    if (this.#released) {
      return Promise.reject(
        new Error(
          "released preparation resources cannot be cleaned by their former owner",
        ),
      );
    }
    this.#cleanup ??= this.#cleanupOnce();
    return this.#cleanup;
  }

  async #cleanupOnce(): Promise<ProjectEnvironmentPreparationCleanupTruthV1> {
    const sandboxCleanupKind =
      this.#broker !== undefined
        ? "broker"
        : this.#brokerSetupCleanup !== undefined
          ? "broker_setup"
          : "none";
    const sandboxCleanupRequired = sandboxCleanupKind !== "none";
    let sandboxCleanupAttempted = false;
    let sandboxCleanupReceiptObserved = false;
    let sandboxComplete = !sandboxCleanupRequired;
    if (this.#brokerSetupCleanup !== undefined) {
      sandboxCleanupAttempted = true;
      for (let attempt = 0; attempt < 3 && !sandboxComplete; attempt += 1) {
        try {
          await this.#brokerSetupCleanup();
          sandboxComplete = true;
        } catch {
          sandboxComplete = false;
        }
      }
    } else if (this.#broker !== undefined) {
      sandboxCleanupAttempted = true;
      try {
        const receipt = await this.#broker.cleanup();
        sandboxCleanupReceiptObserved = true;
        sandboxComplete = sandboxCleanupComplete(receipt);
      } catch {
        sandboxComplete = false;
      }
    }

    let taskRootRemovalAttempted = false;
    let taskRootRemoved = false;
    if (sandboxComplete) {
      taskRootRemovalAttempted = true;
      try {
        const expected = await this.#identity;
        const current = await lstat(this.layout.taskRootDirectory);
        if (
          current.isSymbolicLink() ||
          !current.isDirectory() ||
          current.dev !== expected.dev ||
          current.ino !== expected.ino
        ) {
          throw new Error("prepared Task root identity changed before cleanup");
        }
        await rm(this.layout.taskRootDirectory, {
          recursive: true,
          force: false,
        });
        try {
          await lstat(this.layout.taskRootDirectory);
        } catch (error) {
          taskRootRemoved = isNodeError(error) && error.code === "ENOENT";
        }
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          taskRootRemoved = true;
        }
      }
    }
    const cleanupProven = sandboxComplete && taskRootRemoved;
    return Object.freeze({
      schemaVersion: 1,
      sandboxCleanupKind,
      sandboxCleanupRequired,
      sandboxCleanupAttempted,
      sandboxCleanupReceiptObserved,
      sandboxCleanupComplete: sandboxComplete,
      taskRootRemovalAttempted,
      taskRootRemoved,
      cleanupProven,
    });
  }
}

export class ProjectEnvironmentPreparationInfrastructureErrorV1 extends Error {
  public constructor(
    public readonly stage: string,
    public readonly cleanup: ProjectEnvironmentPreparationCleanupTruthV1,
    cause: unknown,
  ) {
    super("Project Environment Task preparation failed", { cause });
    this.name = "ProjectEnvironmentPreparationInfrastructureErrorV1";
  }
}
