import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/cli/src/vnext/**/*.external-semantic.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    maxConcurrency: 1,
    passWithNoTests: false,
    sequence: { concurrent: false },
    testTimeout: 600_000,
    hookTimeout: 600_000,
    teardownTimeout: 120_000,
  },
});
