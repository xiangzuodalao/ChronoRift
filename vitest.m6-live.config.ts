import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/cli/src/vnext/moddable-platformer.m6.live.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    passWithNoTests: false,
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
    teardownTimeout: 120_000,
  },
});
