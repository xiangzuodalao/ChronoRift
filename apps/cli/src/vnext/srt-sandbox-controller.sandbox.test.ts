import { get } from "node:http";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { SrtSandboxController } from "./srt-sandbox-controller.js";

const getHostEndpoint = (port: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const request = get(
      { host: "127.0.0.1", port, path: "/", timeout: 2_000 },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve(Buffer.concat(chunks).toString("utf8")),
        );
      },
    );
    request.once("error", reject);
    request.once("timeout", () => request.destroy(new Error("timeout")));
  });

it("enforces the small coding and Godot SRT policies on Linux", async () => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-srt-conformance-"));
  const workspacePath = join(root, "candidate");
  const projectStagePath = join(root, "stage", "project");
  const homePath = join(root, "run-home");
  const tempPath = join(root, "run-tmp");
  const artifactsPath = join(root, "artifacts");
  const hostOnlyPath = join(root, "host-only.txt");
  await Promise.all(
    [
      workspacePath,
      join(projectStagePath, ".godot"),
      homePath,
      tempPath,
      artifactsPath,
    ].map(async (path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
  await writeFile(join(projectStagePath, "project.godot"), "[application]\n");
  await writeFile(hostOnlyPath, "host-only\n");

  const server = createServer((_request, response) => {
    response.end("host-network");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const controller = new SrtSandboxController({ defaultTimeoutMs: 10_000 });
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Host conformance server did not expose a TCP port");
    }
    expect(await getHostEndpoint(address.port)).toBe("host-network");

    const coding = await controller.runCoding({
      argv: [
        "/bin/bash",
        "-c",
        'set -eu; if /usr/bin/cat -- "$2" >/dev/null 2>&1; then exit 40; fi; /usr/bin/printf coding-ok >"$1/coding.txt"',
        "chronorift-coding",
        workspacePath,
        hostOnlyPath,
      ],
      cwd: workspacePath,
      workspacePath,
      homePath,
      tempPath,
      artifactsPath,
    });
    expect(coding).toMatchObject({ status: "exited", exitCode: 0 });
    await expect(
      readFile(join(workspacePath, "coding.txt"), "utf8"),
    ).resolves.toBe("coding-ok");

    const godot = await controller.openGodot({
      argv: [
        "/bin/bash",
        "-c",
        'set -eu; if /usr/bin/cat -- "$1/coding.txt" >/dev/null 2>&1; then exit 41; fi; if /usr/bin/printf tampered >"$2/project.godot" 2>/dev/null; then exit 42; fi; /usr/bin/printf cache-ok >"$2/.godot/cache"; /usr/bin/printf tmp-ok >"$3/godot.tmp"; if exec 9<>"/dev/tcp/127.0.0.1/$4" 2>/dev/null; then exit 43; fi',
        "chronorift-godot",
        workspacePath,
        projectStagePath,
        tempPath,
        String(address.port),
      ],
      cwd: projectStagePath,
      projectStagePath,
      mutableWorkspacePath: workspacePath,
      homePath,
      tempPath,
      artifactsPath,
    });
    const godotResult = await godot.wait();
    expect(godotResult, JSON.stringify(godotResult)).toMatchObject({
      status: "exited",
      exitCode: 0,
    });
    await expect(
      readFile(join(projectStagePath, "project.godot"), "utf8"),
    ).resolves.toBe("[application]\n");
    await expect(
      readFile(join(projectStagePath, ".godot", "cache"), "utf8"),
    ).resolves.toBe("cache-ok");
    await expect(readFile(join(tempPath, "godot.tmp"), "utf8")).resolves.toBe(
      "tmp-ok",
    );
  } finally {
    try {
      await controller.close();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }
});
