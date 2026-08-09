import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/cli/src/vnext/**/*.godot-sandbox.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    maxConcurrency: 1,
    passWithNoTests: false,
    sequence: {
      concurrent: false,
    },
    testTimeout: 300_000,
    hookTimeout: 300_000,
    teardownTimeout: 60_000,
  },
});
