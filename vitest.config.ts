import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several M1 suites exercise real filesystem and process boundaries. Capping
    // workers prevents high-core Hosts from turning those checks into I/O races.
    maxWorkers: 4,
    include: ["{apps,packages}/**/*.{test,spec}.ts"],
    exclude: [
      "**/*.live.{test,spec}.ts",
      "**/*.godot.{test,spec}.ts",
      "**/*.sandbox.{test,spec}.ts",
      "**/*.godot-sandbox.{test,spec}.ts",
      "**/*.external-project.{test,spec}.ts",
      "**/node_modules/**",
      "**/dist/**",
    ],
  },
});
