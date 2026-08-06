import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/cli/src/vnext/**/*.sandbox.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
