import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { NodeProcessDriver } from "./process-driver.js";

const execFileAsync = promisify(execFile);

describe("NodeProcessDriver", () => {
  it("passes an adversarial value as one unchanged argv element", async () => {
    const driver = new NodeProcessDriver();
    const adversarial = "spaces ; `echo no` $(echo no)";
    const spawned = driver.start({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify(process.argv[1]))",
        adversarial,
      ],
      cwd: process.cwd(),
      env: {},
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    spawned.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    await expect(spawned.wait()).resolves.toEqual({
      exitCode: 0,
      signal: null,
    });
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toBe(
      adversarial,
    );
  });

  it("requires exactly one IPC descriptor for startIpc", () => {
    const driver = new NodeProcessDriver();
    const request = {
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10)"],
      cwd: process.cwd(),
      env: {},
      detached: false,
      stdio: ["ignore", "pipe", "pipe"] as const,
    };

    expect(() => driver.startIpc(request)).toThrow(/ipc/u);
    expect(() =>
      driver.startIpc({ ...request, stdio: ["ipc", "pipe", "pipe", "ipc"] }),
    ).toThrow(/exactly one/u);
  });

  it("matches execFile behavior without using a shell", async () => {
    const value = "a;b";
    const direct = await execFileAsync(process.execPath, [
      "-e",
      "process.stdout.write(process.argv[1])",
      value,
    ]);
    expect(direct.stdout).toBe(value);
  });
});
