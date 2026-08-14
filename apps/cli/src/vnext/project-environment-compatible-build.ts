import {
  AdapterCompatibilityReceiptV1Schema,
  ProjectEnvironmentBuildBindingV1Schema,
  type ProjectAdapterRevisionV1,
  type ProjectEnvironmentRevisionV1,
  type ProjectToolchainReceiptId,
  type TaskId,
} from "@chronorift/domain";
import {
  ArtifactNotFoundError,
  type ProjectEnvironmentTaskStoreV1,
} from "@chronorift/json-artifacts";

import type { PreparedProjectEnvironmentGodotBuildV1 } from "./candidate-godot-build.js";
import { runProjectEnvironmentCompatibilitySmokeV1 } from "./project-environment-compatibility.js";
import type {
  ProjectEnvironmentGameRuntimeV1,
  ProjectEnvironmentRuntimeBuildV1,
} from "./project-environment-game-runtime.js";

export interface ProjectEnvironmentCompatibleBuildResolverOptionsV1 {
  readonly taskStore: ProjectEnvironmentTaskStoreV1;
  readonly taskId: TaskId;
  readonly revision: ProjectEnvironmentRevisionV1;
  readonly adapterRevision: ProjectAdapterRevisionV1;
  readonly toolchainReceiptId: ProjectToolchainReceiptId;
  readonly launchTargetId: string;
  readonly prepareBuild: () => Promise<PreparedProjectEnvironmentGodotBuildV1>;
  readonly createSmokeRuntime: (
    prepared: PreparedProjectEnvironmentGodotBuildV1,
  ) => ProjectEnvironmentGameRuntimeV1;
  readonly runSmoke?: typeof runProjectEnvironmentCompatibilitySmokeV1;
}

const descriptor = (
  prepared: PreparedProjectEnvironmentGodotBuildV1,
): ProjectEnvironmentRuntimeBuildV1 =>
  Object.freeze({
    schemaVersion: 1,
    buildId: prepared.build.buildId,
    sourceClosureId: prepared.build.sourceId,
    candidateSourceHash: prepared.build.sourceHash,
    expectedMainScene: prepared.configuredMainScene,
  });

const notFound = (error: unknown): boolean =>
  error instanceof ArtifactNotFoundError ||
  (error instanceof Error && "code" in error && error.code === "ENOENT");

/**
 * Freezes the current workspace and exposes a Build only after an exact
 * compatibility receipt is durable. Repeated discovery of unchanged bytes is
 * idempotent; a source edit produces a different Build identity and smoke.
 */
export class ProjectEnvironmentCompatibleBuildResolverV1 {
  #pending: Promise<ProjectEnvironmentRuntimeBuildV1> | null = null;

  public constructor(
    private readonly options: ProjectEnvironmentCompatibleBuildResolverOptionsV1,
  ) {}

  public resolve = (): Promise<ProjectEnvironmentRuntimeBuildV1> => {
    if (this.#pending !== null) return this.#pending;
    const pending = this.resolveOnce().finally(() => {
      if (this.#pending === pending) this.#pending = null;
    });
    this.#pending = pending;
    return pending;
  };

  private async resolveOnce(): Promise<ProjectEnvironmentRuntimeBuildV1> {
    const prepared = await this.options.prepareBuild();
    this.assertPreparedBinding(prepared);
    const prior = await this.readPriorCompatibility(prepared);
    if (prior === "compatible") return descriptor(prepared);
    if (prior === "incompatible") {
      throw new Error(
        `ProjectAdapter compatibility was already rejected for ${prepared.build.buildId}`,
      );
    }

    await this.options.taskStore.putBuildOnce(prepared.build);
    const runtime = this.options.createSmokeRuntime(prepared);
    let compatibility: Awaited<
      ReturnType<typeof runProjectEnvironmentCompatibilitySmokeV1>
    >;
    try {
      compatibility = await (
        this.options.runSmoke ?? runProjectEnvironmentCompatibilitySmokeV1
      )({
        runtime,
        taskStore: this.options.taskStore,
        taskId: this.options.taskId,
        buildId: prepared.build.buildId,
        buildSourceId: prepared.build.sourceId,
        revision: this.options.revision,
        adapterRevision: this.options.adapterRevision,
        toolchainReceiptId: this.options.toolchainReceiptId,
        launchTargetId: this.options.launchTargetId,
      });
    } finally {
      await runtime.close();
    }
    const binding = ProjectEnvironmentBuildBindingV1Schema.parse({
      ...prepared.binding,
      compatibilityStatus: compatibility.outcome,
      compatibilityReceiptId: compatibility.receiptId,
    });
    await this.options.taskStore.putBuildBindingOnce(binding);
    if (compatibility.outcome !== "compatible") {
      throw new Error(
        `ProjectAdapter compatibility rejected: ${compatibility.failures.join("; ")}`,
      );
    }
    return descriptor(prepared);
  }

  private assertPreparedBinding(
    prepared: PreparedProjectEnvironmentGodotBuildV1,
  ): void {
    if (
      prepared.build.taskId !== this.options.taskId ||
      prepared.binding.taskId !== this.options.taskId ||
      prepared.binding.buildId !== prepared.build.buildId ||
      prepared.binding.sourceId !== prepared.build.sourceId ||
      prepared.binding.environmentRevisionId !==
        this.options.revision.environmentRevisionId ||
      prepared.binding.adapterRevisionId !==
        this.options.adapterRevision.adapterRevisionId ||
      this.options.revision.adapterRevisionId !==
        this.options.adapterRevision.adapterRevisionId ||
      this.options.revision.toolchainReceiptId !==
        this.options.toolchainReceiptId
    ) {
      throw new TypeError(
        "prepared candidate Build crossed its Task or Project Environment binding",
      );
    }
  }

  private async readPriorCompatibility(
    prepared: PreparedProjectEnvironmentGodotBuildV1,
  ): Promise<"compatible" | "incompatible" | null> {
    let binding;
    try {
      binding = await this.options.taskStore.readBuildBinding(
        prepared.build.buildId,
      );
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
    if (
      binding.taskId !== this.options.taskId ||
      binding.sourceId !== prepared.build.sourceId ||
      binding.environmentRevisionId !==
        this.options.revision.environmentRevisionId ||
      binding.adapterRevisionId !==
        this.options.adapterRevision.adapterRevisionId ||
      binding.bindingEpochId !== prepared.binding.bindingEpochId ||
      binding.compatibilityReceiptId === null
    ) {
      throw new Error(
        "stored candidate Build binding does not match the current workspace identity",
      );
    }
    const storedBuild = await this.options.taskStore.readBuild(
      prepared.build.buildId,
    );
    if (
      storedBuild.taskId !== prepared.build.taskId ||
      storedBuild.workspaceId !== prepared.build.workspaceId ||
      storedBuild.sourceId !== prepared.build.sourceId ||
      storedBuild.sourceHash !== prepared.build.sourceHash ||
      storedBuild.workspaceDiffHash !== prepared.build.workspaceDiffHash ||
      storedBuild.buildConfigurationHash !==
        prepared.build.buildConfigurationHash ||
      storedBuild.outputHash !== prepared.build.outputHash
    ) {
      throw new Error("stored Build bytes or configuration binding changed");
    }
    const receipt = AdapterCompatibilityReceiptV1Schema.parse(
      await this.options.taskStore.readCompatibilityReceipt(
        binding.compatibilityReceiptId,
      ),
    );
    if (
      receipt.taskId !== this.options.taskId ||
      receipt.buildId !== prepared.build.buildId ||
      receipt.sourceId !== prepared.build.sourceId ||
      receipt.environmentRevisionId !==
        this.options.revision.environmentRevisionId ||
      receipt.adapterRevisionId !==
        this.options.adapterRevision.adapterRevisionId ||
      receipt.toolchainReceiptId !== this.options.toolchainReceiptId ||
      receipt.outcome !== binding.compatibilityStatus
    ) {
      throw new Error(
        "stored compatibility receipt does not match its candidate Build binding",
      );
    }
    return receipt.outcome;
  }
}
