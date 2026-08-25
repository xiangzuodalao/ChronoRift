import { afterEach, describe, expect, it, vi } from "vitest";

import type * as ProjectEnvironmentHostConfigModule from "./project-environment-host-config.js";
import type * as SandboxPreflightModule from "./sandbox-preflight.js";
import type * as SourcePreflightModule from "./source-preflight.js";

const mocks = vi.hoisted(() => ({
  createRuntimeRoot: vi.fn(),
  preflightSource: vi.fn(),
  readHostConfig: vi.fn(),
}));

vi.mock("./project-environment-host-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ProjectEnvironmentHostConfigModule>()),
  readProjectEnvironmentHostConfigV1: mocks.readHostConfig,
}));

vi.mock("./sandbox-preflight.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SandboxPreflightModule>()),
  createSandboxTaskRuntimeRoot: mocks.createRuntimeRoot,
}));

vi.mock("./source-preflight.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SourcePreflightModule>()),
  preflightCleanProjectEnvironmentV1: mocks.preflightSource,
}));

import {
  MOB_ORIENTATION_PROJECT_PREFIX,
  runMobOrientationAblationV1,
} from "./mob-orientation-ablation.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("Mob orientation source admission", () => {
  it("selects the frozen project explicitly inside the upstream multi-project repository", async () => {
    mocks.readHostConfig.mockResolvedValue({
      taskStorageRoot: "/task-storage",
      runtimeRoot: "/task-storage/runtime",
    });
    mocks.createRuntimeRoot.mockResolvedValue("/task-storage/runtime");
    const sentinel = new Error("stop after source admission request");
    mocks.preflightSource.mockRejectedValueOnce(sentinel);

    await expect(
      runMobOrientationAblationV1({
        arm: "coding-only",
        projectPath: "/source/godot-demo-projects/3d/squash_the_creeps",
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        thinkingLevel: "max",
        timeoutMs: 600_000,
        hostConfigPath: "/host-config.json",
      }),
    ).rejects.toBe(sentinel);
    expect(mocks.preflightSource).toHaveBeenCalledWith({
      projectPath: "/source/godot-demo-projects/3d/squash_the_creeps",
      projectRoot: MOB_ORIENTATION_PROJECT_PREFIX,
      sourceRepositoryExclusionRoots: ["/task-storage"],
    });
  });
});
