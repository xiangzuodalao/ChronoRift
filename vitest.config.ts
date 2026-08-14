import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several M1 suites exercise real filesystem and process boundaries. Capping
    // workers prevents high-core Hosts from turning those checks into I/O races.
    maxWorkers: 4,
    // CI runs the filesystem-heavy v0.3 recovery suite beside other workers;
    // keep its deterministic assertions while allowing bounded runner jitter.
    testTimeout: 15_000,
    include: ["{apps,packages}/**/*.{test,spec}.ts"],
    exclude: [
      "**/*.live.{test,spec}.ts",
      "**/*.godot.{test,spec}.ts",
      "**/*.sandbox.{test,spec}.ts",
      "**/*.godot-sandbox.{test,spec}.ts",
      "**/*.external-project.{test,spec}.ts",
      "**/*.external-semantic.{test,spec}.ts",
      "**/*.project-environment-pe-c-host.{test,spec}.ts",
      "**/node_modules/**",
      "**/dist/**",
    ],
  },
});
