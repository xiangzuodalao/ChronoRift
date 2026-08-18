import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/cli/src/vnext/moddable-platformer.m7.live.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    passWithNoTests: false,
    testTimeout: 5_400_000,
    hookTimeout: 5_400_000,
    teardownTimeout: 120_000,
  },
});
