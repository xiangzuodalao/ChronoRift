import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { asTaskId } from "@chronorift/domain";
import { afterEach, describe, expect, it } from "vitest";

import {
  WorkspaceMaterializationReceiptV1Schema,
  WorkspaceMaterializationReceiptV2Schema,
} from "./contracts.js";
import { readGodotProjectDescriptorSnapshotV1 } from "./godot-project-descriptor.js";
import { NodeHostGitPort } from "./host-git.js";
import {
  preflightCleanExternalGodotProject,
  preflightCleanGitSubtree,
  preflightCleanProjectEnvironmentV1,
} from "./source-preflight.js";
import {
  createProjectEnvironmentTaskDirectoryLayout,
  createTaskDirectoryLayout,
} from "./task-paths.js";
import {
  ProjectEnvironmentWorkspaceMaterializationReceiptV1Schema,
  materializePrivateTaskWorkspace,
} from "./workspace-materializer.js";

const execFileAsync = promisify(execFile);
const trustedFixtureRoot = fileURLToPath(
  new URL("../../../../fixtures/godot-frame-input-window", import.meta.url),
);
const temporaryRoots: string[] = [];

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const result = await execFileAsync("/usr/bin/git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout;
};

const commitAll = async (root: string, message = "fixture"): Promise<void> => {
  await git(root, ["add", "--all"]);
  await git(root, [
    "-c",
    "user.name=ChronoRift Test",
    "-c",
    "user.email=test@chronorift.invalid",
    "commit",
    "--quiet",
    "-m",
    message,
  ]);
};

const setup = async (options?: {
  readonly hostileFilterMarker?: string | undefined;
}): Promise<{
  readonly root: string;
  readonly project: string;
  readonly runtimeRoot: string;
  readonly trustedRoot: string;
}> => {
  const container = await mkdtemp(
    join(tmpdir(), "chronorift-workspace-materializer-test-"),
  );
  temporaryRoots.push(container);
  const root = join(container, "repository");
  const project = join(root, "game");
  const runtimeRoot = join(container, "runtime");
  const trustedRoot = join(container, "trusted-fixture");
  await mkdir(project, { recursive: true });
  await mkdir(runtimeRoot);
  await cp(trustedFixtureRoot, trustedRoot, { recursive: true });
  if (options?.hostileFilterMarker !== undefined) {
    await writeFile(
      join(trustedRoot, ".gitattributes"),
      "*.gd filter=hostile diff=hostile\n",
    );
  }
  await cp(trustedRoot, project, { recursive: true });
  await git(root, ["init", "--quiet", "--initial-branch=main"]);
  await writeFile(join(root, "outside.txt"), "outside\n");
  await commitAll(root);
  if (options?.hostileFilterMarker !== undefined) {
    const hostileCommand = `/bin/sh -c 'touch "${options.hostileFilterMarker}"; cat'`;
    await git(root, ["config", "filter.hostile.clean", hostileCommand]);
    await git(root, ["config", "diff.hostile.command", hostileCommand]);
    await writeFile(
      join(root, ".git", "hooks", "post-checkout"),
      `#!/bin/sh\ntouch "${options.hostileFilterMarker}"\n`,
      { mode: 0o755 },
    );
  }
  return { root, project, runtimeRoot, trustedRoot };
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(async (root) => rm(root, { recursive: true, force: true })),
  );
});

describe("materializePrivateTaskWorkspace", () => {
  it("materializes PE-A source with a path-free receipt in its versioned Task layout", async () => {
    const container = await mkdtemp(
      join(tmpdir(), "chronorift-project-environment-materializer-"),
    );
    temporaryRoots.push(container);
    const root = join(container, "repository");
    const runtimeRoot = join(container, "runtime");
    await Promise.all([mkdir(root), mkdir(runtimeRoot)]);
    await writeFile(
      join(root, "project.godot"),
      '[application]\nrun/main_scene="res://main.tscn"\n',
    );
    await writeFile(join(root, "main.tscn"), "[gd_scene format=3]\n");
    await git(root, ["init", "--quiet", "--initial-branch=main"]);
    await commitAll(root, "PE-A project");
    const source = await preflightCleanProjectEnvironmentV1({
      projectPath: root,
      sourceRepositoryExclusionRoots: [runtimeRoot],
    });
    const taskId = asTaskId("task_materialize_project_environment");
    const layout = await createProjectEnvironmentTaskDirectoryLayout({
      runtimeRoot,
      sourceRepositoryRoot: root,
      taskId,
    });

    const materialized = await materializePrivateTaskWorkspace({
      taskId,
      source,
      layout,
    });

    expect(materialized.sourceKind).toBe("project-environment-v1-clean-git");
    expect(
      ProjectEnvironmentWorkspaceMaterializationReceiptV1Schema.parse(
        materialized.receipt,
      ),
    ).toEqual(materialized.receipt);
    expect(JSON.stringify(materialized.receipt)).not.toContain(root);
    expect(materialized.projectSourceIdentity).toBe(
      source.projectSourceIdentity,
    );
    expect(
      await git(layout.workspaceDirectory, ["status", "--porcelain"]),
    ).toBe("");
  });

  it("materializes an external project while keeping descriptor and source checkout outside the candidate", async () => {
    const container = await mkdtemp(
      join(tmpdir(), "chronorift-external-materializer-test-"),
    );
    temporaryRoots.push(container);
    const root = join(container, "repository");
    const runtimeRoot = join(container, "runtime");
    await Promise.all([mkdir(root), mkdir(runtimeRoot)]);
    await writeFile(
      join(root, "project.godot"),
      '[application]\nrun/main_scene="res://main.tscn"\n',
    );
    await writeFile(join(root, "main.tscn"), "[gd_scene format=3]\n");
    await git(root, ["init", "--quiet", "--initial-branch=main"]);
    await commitAll(root, "external project");
    const descriptorPath = join(container, "project.json");
    await writeFile(
      descriptorPath,
      `${JSON.stringify({
        schemaVersion: 1,
        descriptorKind: "chronorift-godot-external-project",
        declaredSourceUrl: "https://github.com/example/project",
        projectFile: "project.godot",
        runtime: {
          engineVersion: "4.7.1-stable (official)",
          scripting: "gdscript",
          renderer: "gl_compatibility",
          executionMode: "headless",
        },
        launch: { scene: "project-main-scene" },
        cache: { ignoredPaths: [".godot"] },
        bridge: { mode: "managed-runtime-overlay", protocolVersion: 1 },
      })}\n`,
    );
    const source = await preflightCleanExternalGodotProject({
      projectPath: root,
      descriptorSnapshot:
        await readGodotProjectDescriptorSnapshotV1(descriptorPath),
      sourceRepositoryExclusionRoots: [runtimeRoot],
    });
    const taskId = asTaskId("task_materialize_external");
    const layout = await createTaskDirectoryLayout({
      runtimeRoot,
      sourceRepositoryRoot: root,
      taskId,
    });

    const materialized = await materializePrivateTaskWorkspace({
      taskId,
      source,
      layout,
    });

    expect(
      WorkspaceMaterializationReceiptV2Schema.parse(materialized.receipt),
    ).toEqual(materialized.receipt);
    expect(materialized.receipt.sourcePostflight).toMatchObject({
      observedHeadCommit: source.headCommit,
      observedSelectedTreeSha256: source.selectedTreeSha256,
      stagingWorktreeRegistered: false,
    });
    await expect(
      access(join(layout.workspaceDirectory, "project.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(root, ["status", "--porcelain"])).toBe("");
    expect(materialized.projectCapability).toEqual(source.projectCapability);
  });

  it("streams raw objects without filters and restores Host worktree metadata", async () => {
    const markerContainer = await mkdtemp(
      join(tmpdir(), "chronorift-hostile-filter-marker-"),
    );
    temporaryRoots.push(markerContainer);
    const marker = join(markerContainer, "filter-ran");
    const repo = await setup({ hostileFilterMarker: marker });
    const taskId = asTaskId("task_materialize_raw_fixture");
    const layout = await createTaskDirectoryLayout({
      runtimeRoot: repo.runtimeRoot,
      sourceRepositoryRoot: repo.root,
      taskId,
    });
    const beforeRefs = await git(repo.root, ["show-ref"]);
    const beforeWorktrees = await git(repo.root, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    const beforeConfig = await readFile(join(repo.root, ".git", "config"));
    const beforeIndex = await readFile(join(repo.root, ".git", "index"));
    const source = await preflightCleanGitSubtree({
      projectPath: repo.project,
      trustedFixtureRoot: repo.trustedRoot,
      sourceRepositoryExclusionRoots: [repo.runtimeRoot],
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });

    const materialized = await materializePrivateTaskWorkspace({
      taskId,
      source,
      layout,
    });

    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(repo.root, ["show-ref"])).toBe(beforeRefs);
    expect(await git(repo.root, ["worktree", "list", "--porcelain"])).toBe(
      beforeWorktrees,
    );
    expect(await readFile(join(repo.root, ".git", "config"))).toEqual(
      beforeConfig,
    );
    expect(await readFile(join(repo.root, ".git", "index"))).toEqual(
      beforeIndex,
    );
    expect(materialized.receipt.selectedTreeSha256).toBe(
      source.selectedTreeSha256,
    );
    expect(
      WorkspaceMaterializationReceiptV1Schema.parse(materialized.receipt),
    ).toEqual(materialized.receipt);
    expect(
      await readFile(join(layout.workspaceDirectory, "frame_input_window.gd")),
    ).toEqual(await readFile(join(repo.project, "frame_input_window.gd")));
    expect(
      await git(layout.workspaceDirectory, ["status", "--porcelain"]),
    ).toBe("");
    expect(isAbsolute(materialized.hostBaselineGitDirectory)).toBe(true);
    for (const writableRoot of [
      layout.workspaceDirectory,
      layout.sandboxTemporaryDirectory,
      layout.sandboxArtifactScratchDirectory,
    ]) {
      const difference = relative(
        writableRoot,
        materialized.hostBaselineGitDirectory,
      );
      expect(
        difference === "" ||
          (!difference.startsWith("..") && !isAbsolute(difference)),
      ).toBe(false);
    }
  });

  it("materializes an executable and binary file byte-for-byte", async () => {
    const repo = await setup();
    await writeFile(join(repo.trustedRoot, "run.sh"), "#!/bin/sh\n", {
      mode: 0o755,
    });
    await writeFile(
      join(repo.trustedRoot, "binary.bin"),
      Buffer.from([0, 255, 1, 2, 0]),
    );
    await writeFile(join(repo.project, "run.sh"), "#!/bin/sh\n", {
      mode: 0o755,
    });
    await writeFile(
      join(repo.project, "binary.bin"),
      Buffer.from([0, 255, 1, 2, 0]),
    );
    await commitAll(repo.root, "binary and executable");
    const taskId = asTaskId("task_materialize_modes");
    const layout = await createTaskDirectoryLayout({
      runtimeRoot: repo.runtimeRoot,
      sourceRepositoryRoot: repo.root,
      taskId,
    });
    const source = await preflightCleanGitSubtree({
      projectPath: repo.project,
      trustedFixtureRoot: repo.trustedRoot,
      sourceRepositoryExclusionRoots: [repo.runtimeRoot],
    });

    await materializePrivateTaskWorkspace({ taskId, source, layout });

    expect(
      await readFile(join(layout.workspaceDirectory, "binary.bin")),
    ).toEqual(Buffer.from([0, 255, 1, 2, 0]));
    expect(
      source.entries.find((entry) => entry.relativePath === "run.sh")?.mode,
    ).toBe("100755");
  });

  it("cleans the staging worktree when a destination already exists", async () => {
    const repo = await setup();
    const taskId = asTaskId("task_materialize_write_failure");
    const layout = await createTaskDirectoryLayout({
      runtimeRoot: repo.runtimeRoot,
      sourceRepositoryRoot: repo.root,
      taskId,
    });
    const source = await preflightCleanGitSubtree({
      projectPath: repo.project,
      trustedFixtureRoot: repo.trustedRoot,
      sourceRepositoryExclusionRoots: [repo.runtimeRoot],
    });
    const beforeWorktrees = await git(repo.root, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    await writeFile(
      join(layout.workspaceDirectory, "project.godot"),
      "occupied",
    );

    await expect(
      materializePrivateTaskWorkspace({ taskId, source, layout }),
    ).rejects.toMatchObject({ code: "artifact_write_failed" });
    expect(await git(repo.root, ["worktree", "list", "--porcelain"])).toBe(
      beforeWorktrees,
    );
  });

  it("fails closed when staging cleanup cannot be proven", async () => {
    class CleanupFailingGit extends NodeHostGitPort {
      public override async removeWorktree(): Promise<void> {
        throw new Error("injected cleanup failure");
      }
    }
    const repo = await setup();
    const taskId = asTaskId("task_materialize_cleanup_failure");
    const layout = await createTaskDirectoryLayout({
      runtimeRoot: repo.runtimeRoot,
      sourceRepositoryRoot: repo.root,
      taskId,
    });
    const source = await preflightCleanGitSubtree({
      projectPath: repo.project,
      trustedFixtureRoot: repo.trustedRoot,
      sourceRepositoryExclusionRoots: [repo.runtimeRoot],
    });

    await expect(
      materializePrivateTaskWorkspace(
        { taskId, source, layout },
        { git: new CleanupFailingGit() },
      ),
    ).rejects.toMatchObject({
      code: "artifact_write_failed",
      message: "staging worktree cleanup could not be proven",
    });
  });
});
