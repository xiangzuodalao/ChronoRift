import type {
  ProjectAdapterRevisionV1,
  ProjectEnvironmentRevisionV1,
  ProjectToolchainReceiptId,
  TaskId,
} from "@chronorift/domain";
import type { ProjectEnvironmentTaskStoreV1 } from "@chronorift/json-artifacts";

import type { PreparedProjectEnvironmentGodotBuildV1 } from "./candidate-godot-build.js";
import { ProjectEnvironmentCompatibleBuildResolverV1 } from "./project-environment-compatible-build.js";
import type {
  ProjectEnvironmentGameRuntimeV1,
  ProjectEnvironmentRuntimeBuildV1,
} from "./project-environment-game-runtime.js";
import type { runProjectEnvironmentCompatibilitySmokeV1 } from "./project-environment-compatibility.js";

export interface ProjectEnvironmentRuntimeCompositionOptionsV1 {
  readonly taskStore: ProjectEnvironmentTaskStoreV1;
  readonly taskId: TaskId;
  readonly revision: ProjectEnvironmentRevisionV1;
  readonly adapterRevision: ProjectAdapterRevisionV1;
  readonly toolchainReceiptId: ProjectToolchainReceiptId;
  readonly launchTargetId: string;
  readonly prepareBuild: () => Promise<PreparedProjectEnvironmentGodotBuildV1>;
  readonly createRuntime: (
    build: ProjectEnvironmentRuntimeBuildV1,
    resolveCompatibleBuild?: () => Promise<ProjectEnvironmentRuntimeBuildV1>,
  ) => ProjectEnvironmentGameRuntimeV1;
  readonly runSmoke?: typeof runProjectEnvironmentCompatibilitySmokeV1;
  readonly onResolved?: (
    build: ProjectEnvironmentRuntimeBuildV1,
  ) => void | Promise<void>;
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

/**
 * Composes one non-recursive smoke runtime and one long-lived Agent runtime.
 * Only the latter receives the resolver, so its capabilities/launch calls can
 * refresh edited workspace bytes without recursively resolving during smoke.
 */
export function composeProjectEnvironmentCompatibleRuntimeV1(
  options: ProjectEnvironmentRuntimeCompositionOptionsV1,
): {
  readonly resolve: () => Promise<{
    readonly build: ProjectEnvironmentRuntimeBuildV1;
    readonly runtime: ProjectEnvironmentGameRuntimeV1;
  }>;
} {
  const resolver = new ProjectEnvironmentCompatibleBuildResolverV1({
    taskStore: options.taskStore,
    taskId: options.taskId,
    revision: options.revision,
    adapterRevision: options.adapterRevision,
    toolchainReceiptId: options.toolchainReceiptId,
    launchTargetId: options.launchTargetId,
    prepareBuild: options.prepareBuild,
    createSmokeRuntime: (prepared) =>
      options.createRuntime(descriptor(prepared)),
    ...(options.runSmoke === undefined ? {} : { runSmoke: options.runSmoke }),
  });
  const resolve = async (): Promise<ProjectEnvironmentRuntimeBuildV1> => {
    const build = await resolver.resolve();
    await options.onResolved?.(build);
    return build;
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
