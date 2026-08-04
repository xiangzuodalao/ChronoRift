import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages}/**/*.{test,spec}.ts"],
    exclude: ["**/*.live.{test,spec}.ts", "**/node_modules/**", "**/dist/**"],
  },
});
