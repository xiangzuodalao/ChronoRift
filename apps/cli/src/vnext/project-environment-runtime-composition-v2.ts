import {
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
import { runProjectEnvironmentCompatibilitySmokeV2 } from "./project-environment-compatibility-v2.js";
import type {
  ProjectEnvironmentGameRuntimeV2,
  ProjectEnvironmentRuntimeBuildV2,
} from "./project-environment-game-runtime-v2.js";

const descriptor = (
  prepared: PreparedProjectEnvironmentGodotBuildV1,
): ProjectEnvironmentRuntimeBuildV2 => ({
  schemaVersion: 1,
  buildId: prepared.build.buildId,
  sourceClosureId: prepared.build.sourceId,
  candidateSourceHash: prepared.build.sourceHash,
  expectedMainScene: prepared.configuredMainScene,
});
const missing = (error: unknown) =>
  error instanceof ArtifactNotFoundError ||
  (error instanceof Error && "code" in error && error.code === "ENOENT");

export function composeProjectEnvironmentCompatibleRuntimeV2(options: {
  readonly taskStore: ProjectEnvironmentTaskStoreV1;
  readonly taskId: TaskId;
  readonly revision: ProjectEnvironmentRevisionV1;
  readonly adapterRevision: ProjectAdapterRevisionV1;
  readonly toolchainReceiptId: ProjectToolchainReceiptId;
  readonly launchTargetId: string;
  readonly prepareBuild: () => Promise<PreparedProjectEnvironmentGodotBuildV1>;
  readonly createRuntime: (
    build: ProjectEnvironmentRuntimeBuildV2,
    resolve?: () => Promise<ProjectEnvironmentRuntimeBuildV2>,
  ) => ProjectEnvironmentGameRuntimeV2;
  readonly onResolved?: (
    build: ProjectEnvironmentRuntimeBuildV2,
  ) => void | Promise<void>;
}) {
  let pending: Promise<ProjectEnvironmentRuntimeBuildV2> | null = null;
  const resolve = (): Promise<ProjectEnvironmentRuntimeBuildV2> => {
    if (pending !== null) return pending;
    const operation = (async () => {
      const prepared = await options.prepareBuild();
      if (
        prepared.build.taskId !== options.taskId ||
        prepared.binding.environmentRevisionId !==
          options.revision.environmentRevisionId ||
        prepared.binding.adapterRevisionId !==
          options.adapterRevision.adapterRevisionId
      )
        throw new Error(
          "prepared V2 Build crossed its Task/environment binding",
        );
      try {
        const prior = await options.taskStore.readBuildBinding(
          prepared.build.buildId,
        );
        if (
          prior.compatibilityReceiptId === null ||
          prior.compatibilityStatus !== "compatible"
        )
          throw new Error("stored V2 Build compatibility is incomplete");
        const receipt = await options.taskStore.readCompatibilityReceiptV2(
          prior.compatibilityReceiptId,
        );
        if (
          receipt.outcome !== "compatible" ||
          receipt.buildId !== prepared.build.buildId ||
          receipt.environmentRevisionId !==
            options.revision.environmentRevisionId
        )
          throw new Error(
            "stored V2 compatibility receipt crossed its Build binding",
          );
      } catch (error) {
        if (!missing(error)) throw error;
        await options.taskStore.putBuildOnce(prepared.build);
        const runtime = options.createRuntime(descriptor(prepared));
        let receipt;
        try {
          receipt = await runProjectEnvironmentCompatibilitySmokeV2({
            runtime,
            taskStore: options.taskStore,
            taskId: options.taskId,
            buildId: prepared.build.buildId,
            buildSourceId: prepared.build.sourceId,
            revision: options.revision,
            adapterRevision: options.adapterRevision,
            toolchainReceiptId: options.toolchainReceiptId,
            launchTargetId: options.launchTargetId,
          });
        } finally {
          await runtime.close();
        }
        await options.taskStore.putBuildBindingOnce(
          ProjectEnvironmentBuildBindingV1Schema.parse({
            ...prepared.binding,
            compatibilityStatus: receipt.outcome,
            compatibilityReceiptId: receipt.receiptId,
          }),
        );
        if (receipt.outcome !== "compatible")
          throw new Error(
            `V2 compatibility rejected: ${receipt.failures.join("; ")}`,
          );
      }
      const build = descriptor(prepared);
      await options.onResolved?.(build);
      return build;
    })().finally(() => {
      pending = null;
    });
    pending = operation;
    return operation;
  };
  return Object.freeze({
    resolve: async () => {
      const build = await resolve();
      return Object.freeze({
        build,
        runtime: options.createRuntime(build, resolve),
      });
    },
  });
}
