import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/*.live.{test,spec}.ts"],
    exclude: ["apps/cli/src/vnext/frame-input-window-release.live.test.ts"],
    testTimeout: 180_000,
  },
});
