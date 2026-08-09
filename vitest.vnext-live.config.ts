import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/cli/src/vnext/frame-input-window-release.live.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    passWithNoTests: false,
    testTimeout: 1_200_000,
    hookTimeout: 1_200_000,
    teardownTimeout: 120_000,
  },
});
