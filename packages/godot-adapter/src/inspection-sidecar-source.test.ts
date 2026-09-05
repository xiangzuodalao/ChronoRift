import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { createGodotInspectionSidecarSource } from "./inspection-sidecar-source.js";
import { GodotInspectionWireClient } from "./inspection-wire-client.js";

it("rejects unbounded configuration and noncanonical Host-owned paths", () => {
  const defaults = {
    godotExecutable: "/usr/bin/godot",
    projectRoot: "/tmp/inspection-stage",
    executionId: "execution.test",
  };
  expect(() =>
    createGodotInspectionSidecarSource({
      ...defaults,
      projectRoot: "/tmp/../outside",
    }),
  ).toThrow("normalized");
  expect(() =>
    createGodotInspectionSidecarSource({
      ...defaults,
      importTimeoutMs: Infinity,
    }),
  ).toThrow("timeout");
  expect(() =>
    createGodotInspectionSidecarSource({
      ...defaults,
      executionId: "execution/other",
    }),
  ).toThrow("executionId");
});

it("returns actual import spawn failure and terminates without starting a game", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      createGodotInspectionSidecarSource({
        godotExecutable: "/chronorift-missing-inspection-godot/godot",
        projectRoot: process.cwd(),
        executionId: "execution.spawn-failure",
      }),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const client = new GodotInspectionWireClient({
    readable: child.stdout,
    write: (bytes) =>
      new Promise<void>((resolve, reject) =>
        child.stdin.write(bytes, (error) =>
          error ? reject(error) : resolve(),
        ),
      ),
    close: async () => {
      child.stdin.end();
    },
  });
  try {
    await expect(client.ready(5_000)).rejects.toThrow(/ENOENT|exited/u);
    const result = await client.termination;
    expect(result.run).toBeNull();
    expect(result.import?.exitCode).not.toBe(0);
    expect(result.import?.timedOut).toBe(false);
  } finally {
    child.kill("SIGKILL");
    await client.close();
  }
});
