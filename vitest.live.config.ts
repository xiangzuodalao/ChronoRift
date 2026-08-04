import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/*.live.{test,spec}.ts"],
    testTimeout: 180_000,
  },
});
