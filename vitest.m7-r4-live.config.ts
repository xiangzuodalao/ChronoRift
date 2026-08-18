import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/cli/src/vnext/moddable-platformer.m7-r4.live.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    passWithNoTests: false,
    testTimeout: 10_800_000,
    hookTimeout: 10_800_000,
    teardownTimeout: 180_000,
  },
});
