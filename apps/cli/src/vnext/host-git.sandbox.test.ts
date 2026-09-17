import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { NodeHostGitPort } from "./host-git.js";
import { SrtSandboxController } from "./srt-sandbox-controller.js";

it("allows ordinary sandboxed git diff in a Host-initialized repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-git-diff-"));
  const workspacePath = join(root, "workspace");
  const homePath = join(root, "home");
  const tempPath = join(root, "tmp");
  const artifactsPath = join(root, "artifacts");
  const controller = new SrtSandboxController({ defaultTimeoutMs: 10_000 });
  try {
    await Promise.all(
      [workspacePath, homePath, tempPath, artifactsPath].map(async (path) =>
        mkdir(path, { mode: 0o700 }),
      ),
    );
    await new NodeHostGitPort().initializeRepository({
      directory: workspacePath,
      bare: false,
    });
    await writeFile(join(workspacePath, "tracked.txt"), "before\n");

    const result = await controller.runCoding({
      argv: [
        "/bin/bash",
        "-c",
        "set -eu; git add -- tracked.txt; printf 'after\\n' >tracked.txt; git diff -- tracked.txt; git diff --check",
      ],
      cwd: workspacePath,
      workspacePath,
      homePath,
      tempPath,
      artifactsPath,
    });
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "exited",
      exitCode: 0,
      stderr: "",
    });
    expect(result.stdout).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(result.stdout).toContain("-before\n+after\n");
  } finally {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  }
});
