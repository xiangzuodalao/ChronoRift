import { describe, expect, it, vi } from "vitest";

import {
  PROJECT_CAPABILITY_MODULE_NAMES_V1,
  ProjectCapabilitySetV1Schema,
} from "@chronorift/domain";
import type {
  GodotProjectEnvironmentRuntimeClientV2,
  LoadedProjectAdapterPackageV2,
} from "@chronorift/godot-adapter";
import { validateProjectEnvironmentGameToolOutputV1 } from "@chronorift/agent-protocol";

import { ProjectEnvironmentGameRuntimeV2 } from "./project-environment-game-runtime-v2.js";
import type { ManagedGodotProjectEnvironmentRuntimeCapabilityV2 } from "./managed-godot-project-environment-runtime-v2.js";
import type { GodotProjectEnvironmentSidecarPortV2 } from "./project-environment-sidecar-port-v2.js";

const taskId = "task.v2.targets";
const build = {
  schemaVersion: 1 as const,
  buildId: "build.v2.targets",
  sourceClosureId: "source.v2.targets",
  candidateSourceHash: "1".repeat(64),
  expectedMainScene: "res://main.tscn",
};
const main = {
  schemaVersion: 2 as const,
  targetId: "main",
  scene: "res://main.tscn",
  default: true,
  parametersSchemaId: "launch.params",
  renderer: "headless" as const,
  requiredModules: [],
};
const secondary = {
  ...main,
  targetId: "secondary",
  scene: "res://secondary.tscn",
  default: false,
};
const adapterPackage = {
  manifest: { launchTargets: [main, secondary] },
  launchTargetSelection: {
    defaultTarget: main,
    selectedTarget: main,
    targetsToValidate: [main],
  },
} as unknown as LoadedProjectAdapterPackageV2;
const capabilitySet = ProjectCapabilitySetV1Schema.parse({
  schemaVersion: 1,
  modules: PROJECT_CAPABILITY_MODULE_NAMES_V1.map((module) => ({
    schemaVersion: 1,
    module,
    status: "implemented",
    protocolVersion: "project-adapter-module:v2",
    limitations: [],
  })),
});

const runtime = (options?: {
  readonly openManaged?: ReturnType<typeof vi.fn>;
  readonly validatedLaunchTargetIds?: readonly string[];
  readonly compatibleLaunchTargetId?: string;
  readonly connect?: () => Promise<GodotProjectEnvironmentRuntimeClientV2>;
  readonly resolveBuild?: () => Promise<typeof build>;
}) =>
  new ProjectEnvironmentGameRuntimeV2({
    taskId,
    environmentRevisionId: "environment-revision.v2.targets",
    adapterRevisionId: "adapter-revision.v2.targets",
    adapterPackage,
    ...(options?.validatedLaunchTargetIds === undefined
      ? {}
      : { validatedLaunchTargetIds: options.validatedLaunchTargetIds }),
    ...(options?.compatibleLaunchTargetId === undefined
      ? {}
      : { compatibleLaunchTargetId: options.compatibleLaunchTargetId }),
    capabilitySet,
    managedRuntime: {
      managedRuntimeId: `managed-godot-project-environment:v2:${"2".repeat(64)}`,
      overlayHash: "3".repeat(64),
      addonHash: "4".repeat(64),
    } as ManagedGodotProjectEnvironmentRuntimeCapabilityV2,
    sidecar: {
      openManaged: options?.openManaged ?? vi.fn(),
    } as unknown as GodotProjectEnvironmentSidecarPortV2,
    adapterManifestSha256: "5".repeat(64),
    sdkSha256: "6".repeat(64),
    bridgeSha256: "7".repeat(64),
    toolchainSha256: "8".repeat(64),
    engineVersion: "4.7.1-stable (official)",
    resolveBuild: options?.resolveBuild ?? (async () => build),
    persistPinnedCapture: async () => undefined,
    persistRuntimeObservation: async () => undefined,
    ...(options?.connect === undefined ? {} : { connect: options.connect }),
  });

const invoke = (
  target: ProjectEnvironmentGameRuntimeV2,
  toolName: "game_capabilities" | "game_launch",
  input: Record<string, unknown>,
) =>
  target.invoke({
    schemaVersion: 1,
    toolCallId: `tool-call.${toolName}`,
    toolName,
    input,
  }) as Promise<{
    readonly outcome: "success" | "error";
    readonly output?: unknown;
    readonly error?: { readonly code: string; readonly message: string };
  }>;

describe("ProjectEnvironmentGameRuntimeV2 launch targets", () => {
  it("reports target validation state in capabilities", async () => {
    const result = await invoke(runtime(), "game_capabilities", {
      schemaVersion: 1,
      taskId,
    });

    expect(result).toMatchObject({
      outcome: "success",
      output: {
        launchTargets: [
          { targetId: "main", validationStatus: "validated" },
          {
            targetId: "secondary",
            validationStatus: "declared_unvalidated",
          },
        ],
      },
    });
    expect(
      validateProjectEnvironmentGameToolOutputV1(
        "game_capabilities",
        result.output,
      ),
    ).toBe(true);
  });

  it("rejects a declared unvalidated target before opening the sidecar", async () => {
    const openManaged = vi.fn();
    const result = await invoke(runtime({ openManaged }), "game_launch", {
      schemaVersion: 1,
      taskId,
      buildId: build.buildId,
      launchTargetId: "secondary",
      parameters: {},
    });

    expect(result).toMatchObject({
      outcome: "error",
      error: {
        code: "target_not_validated",
      },
    });
    expect(openManaged).not.toHaveBeenCalled();
  });

  it("returns target_not_validated for a target absent from the manifest", async () => {
    const openManaged = vi.fn();
    const result = await invoke(runtime({ openManaged }), "game_launch", {
      schemaVersion: 1,
      taskId,
      buildId: build.buildId,
      launchTargetId: "missing",
      parameters: {},
    });

    expect(result).toMatchObject({
      outcome: "error",
      error: { code: "target_not_validated" },
    });
    expect(openManaged).not.toHaveBeenCalled();
  });

  it("serializes close after admitted runtime operations and rejects later calls", async () => {
    let releaseBuild!: (value: typeof build) => void;
    const pendingBuild = new Promise<typeof build>((resolve) => {
      releaseBuild = resolve;
    });
    const target = runtime({ resolveBuild: () => pendingBuild });
    const capabilities = invoke(target, "game_capabilities", {
      schemaVersion: 1,
      taskId,
    });
    let closeCompleted = false;
    const closing = target.close().then(() => {
      closeCompleted = true;
    });

    await Promise.resolve();
    expect(closeCompleted).toBe(false);
    releaseBuild(build);
    await expect(capabilities).resolves.toMatchObject({ outcome: "success" });
    await closing;
    expect(closeCompleted).toBe(true);
    await expect(
      invoke(target, "game_capabilities", { schemaVersion: 1, taskId }),
    ).resolves.toMatchObject({
      outcome: "error",
      error: { code: "runtime_closed" },
    });
  });

  it("passes a validated secondary scene to Godot and verifies the realized current scene", async () => {
    const completion = new Promise<never>(() => undefined);
    const openManaged = vi.fn(async () => ({
      kind: "opened" as const,
      sidecar: {
        transport: {},
        completion,
        diagnostics: () => [],
        terminate: async () => undefined,
      },
    }));
    const idle = new Promise<never>(() => undefined);
    const connect = vi.fn(
      async () =>
        ({
          fingerprint: { renderer: "headless" },
          ready: {
            running: true,
            configuredMainScene: "res://main.tscn",
            currentScene: "res://secondary.tscn",
            clock: {
              processFrame: 0,
              physicsTick: 0,
              simulationTimeUs: 0,
              renderFrame: null,
            },
            nextObservationRecordSequence: 0,
            coverage: {
              status: "complete",
              firstAvailableRecordSequence: null,
              lastAvailableRecordSequence: null,
              droppedRecordCount: 0,
              overwriteCount: 0,
              semanticCoverage: "declared",
            },
          },
          nextObservationBatch: () => idle,
          acknowledgeObservationBatch: async () => undefined,
        }) as unknown as GodotProjectEnvironmentRuntimeClientV2,
    );
    const result = await invoke(
      runtime({
        openManaged,
        validatedLaunchTargetIds: ["main", "secondary"],
        compatibleLaunchTargetId: "secondary",
        connect,
      }),
      "game_launch",
      {
        schemaVersion: 1,
        taskId,
        buildId: build.buildId,
        launchTargetId: "secondary",
        parameters: {},
      },
    );

    expect(result.outcome).toBe("success");
    expect(openManaged).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedMainScene: "res://main.tscn",
        launchScene: "res://secondary.tscn",
      }),
    );
  });

  it("does not treat publication validation as compatibility for another target", async () => {
    const openManaged = vi.fn();
    const result = await invoke(
      runtime({
        openManaged,
        validatedLaunchTargetIds: ["main", "secondary"],
        compatibleLaunchTargetId: "secondary",
      }),
      "game_launch",
      {
        schemaVersion: 1,
        taskId,
        buildId: build.buildId,
        launchTargetId: "main",
        parameters: {},
      },
    );

    expect(result).toMatchObject({
      outcome: "error",
      error: { code: "target_not_compatible" },
    });
    expect(openManaged).not.toHaveBeenCalled();
  });
});
