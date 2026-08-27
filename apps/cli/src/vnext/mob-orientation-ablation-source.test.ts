import { afterEach, describe, expect, it, vi } from "vitest";

import type * as SrtRuntimeConfigModule from "./srt-runtime-config.js";
import type * as SourcePreflightModule from "./source-preflight.js";

const mocks = vi.hoisted(() => ({
  preflightSource: vi.fn(),
  resolveRuntimeConfig: vi.fn(),
}));

vi.mock("./srt-runtime-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SrtRuntimeConfigModule>()),
  resolveSrtRuntimeConfig: mocks.resolveRuntimeConfig,
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
    mocks.resolveRuntimeConfig.mockResolvedValue({
      stateRoot: "/task-storage",
      nodePath: "/usr/bin/node",
      godot: {
        receipt: {},
        binding: { executablePath: "/usr/bin/godot" },
      },
    });
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
        stateRoot: "/task-storage",
        godotBin: "/usr/bin/godot",
      }),
    ).rejects.toBe(sentinel);
    expect(mocks.resolveRuntimeConfig).toHaveBeenCalledWith({
      stateRoot: "/task-storage",
      godotBin: "/usr/bin/godot",
    });
    expect(mocks.preflightSource).toHaveBeenCalledWith({
      projectPath: "/source/godot-demo-projects/3d/squash_the_creeps",
      projectRoot: MOB_ORIENTATION_PROJECT_PREFIX,
      sourceRepositoryExclusionRoots: ["/task-storage"],
    });
  });
});
