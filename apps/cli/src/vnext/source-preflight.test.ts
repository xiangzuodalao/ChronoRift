import { execFile } from "node:child_process";
import {
  access,
  appendFile,
  cp,
  mkdtemp,
  mkdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { NodeHostGitPort } from "./host-git.js";
import { readGodotProjectDescriptorSnapshotV1 } from "./godot-project-descriptor.js";
import {
  parseGitTreeListing,
  preflightCleanGitSubtree,
  preflightCleanExternalGodotProject,
  preflightCleanProjectEnvironmentV1,
} from "./source-preflight.js";

const execFileAsync = promisify(execFile);
const trustedFixtureRoot = fileURLToPath(
  new URL("../../../../fixtures/godot-frame-input-window", import.meta.url),
);
const temporaryRoots: string[] = [];

interface FixtureRepository {
  readonly container: string;
  readonly root: string;
  readonly project: string;
  readonly runtimeRoot: string;
}

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

const createCommittedFixtureRepository = async (options?: {
  readonly projectDirectory?: string | undefined;
  readonly trustedRoot?: string | undefined;
}): Promise<FixtureRepository> => {
  const container = await mkdtemp(
    join(tmpdir(), "chronorift-source-preflight-test-"),
  );
  temporaryRoots.push(container);
  const root = join(container, "repository");
  const runtimeRoot = join(container, "runtime");
  await mkdir(root);
  await mkdir(runtimeRoot);
  const project =
    options?.projectDirectory === undefined
      ? join(root, "game")
      : options.projectDirectory.length === 0
        ? root
        : join(root, options.projectDirectory);
  if (project !== root) await mkdir(project, { recursive: true });
  await cp(options?.trustedRoot ?? trustedFixtureRoot, project, {
    recursive: true,
  });
  await git(root, ["init", "--quiet", "--initial-branch=main"]);
  if (project !== root) {
    await writeFile(join(root, "outside-tracked.txt"), "outside\n");
  }
  await commitAll(root);
  return { container, root, project, runtimeRoot };
};

const requestFor = (repo: FixtureRepository) => ({
  projectPath: repo.project,
  trustedFixtureRoot,
  sourceRepositoryExclusionRoots: [repo.runtimeRoot],
});

const externalDescriptor = {
  schemaVersion: 1,
  descriptorKind: "chronorift-godot-external-project",
  declaredSourceUrl: "https://github.com/endlessm/moddable-platformer",
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
} as const;

const externalRequestFor = async (repo: FixtureRepository) => {
  const descriptorPath = join(repo.container, "external-project.json");
  await writeFile(descriptorPath, `${JSON.stringify(externalDescriptor)}\n`);
  return {
    projectPath: repo.project,
    descriptorSnapshot:
      await readGodotProjectDescriptorSnapshotV1(descriptorPath),
    sourceRepositoryExclusionRoots: [repo.runtimeRoot],
  } as const;
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(async (root) => rm(root, { recursive: true, force: true })),
  );
});

describe("preflightCleanGitSubtree", () => {
  it("rejects oversized Git tree metadata before streaming source blobs", () => {
    const objectId = "a".repeat(40);
    const listing = Buffer.from(
      `100644 blob ${objectId} 536870913\tgame/large.bin\0`,
      "utf8",
    );
    expect(() => parseGitTreeListing(listing, "game")).toThrow(
      /bounded M1 source profile/u,
    );
  });

  it.each([
    ["nested project", "game"],
    ["repository-root project", ""],
    ["pathspec-magic directory", ":(glob)game"],
  ])("accepts a clean exact %s", async (_label, projectDirectory) => {
    const repo = await createCommittedFixtureRepository({ projectDirectory });

    const source = await preflightCleanGitSubtree(requestFor(repo));

    expect(source.projectPrefix).toBe(projectDirectory);
    expect(source.entries.map((entry) => entry.relativePath)).toEqual([
      "chronorift.fixture.json",
      "frame_input_window.gd",
      "frame_input_window.tscn",
      "project.godot",
    ]);
    expect(source.selectedTreeSha256).toBe(
      source.fixtureCapability.baselineSelectedTreeSha256,
    );
  });

  it.each(["tracked", "untracked"] as const)(
    "rejects %s dirt anywhere in the enclosing repository",
    async (kind) => {
      const repo = await createCommittedFixtureRepository();
      if (kind === "tracked") {
        await writeFile(join(repo.root, "outside-tracked.txt"), "changed\n");
      } else {
        await writeFile(join(repo.root, "outside-untracked.txt"), "new\n");
      }

      await expect(
        preflightCleanGitSubtree(requestFor(repo)),
      ).rejects.toMatchObject({ code: "source_not_clean" });
    },
  );

  it.each(["--skip-worktree", "--assume-unchanged"] as const)(
    "rejects tracked dirt hidden by %s",
    async (indexFlag) => {
      const repo = await createCommittedFixtureRepository();
      await git(repo.root, ["update-index", indexFlag, "outside-tracked.txt"]);
      await writeFile(join(repo.root, "outside-tracked.txt"), "hidden dirt\n");
      expect(await git(repo.root, ["status", "--porcelain"])).toBe("");

      await expect(
        preflightCleanGitSubtree(requestFor(repo)),
      ).rejects.toMatchObject({ code: "source_not_clean" });
    },
  );

  it("does not execute a clean filter from worktree-scoped Git config", async () => {
    const repo = await createCommittedFixtureRepository();
    await writeFile(
      join(repo.project, ".gitattributes"),
      "*.gd filter=hostile\n",
    );
    await commitAll(repo.root, "attributes");
    const marker = join(repo.container, "worktree-filter-ran");
    await git(repo.root, ["config", "extensions.worktreeConfig", "true"]);
    await git(repo.root, [
      "config",
      "--worktree",
      "filter.hostile.clean",
      `/bin/sh -c 'touch "${marker}"; cat'`,
    ]);
    await writeFile(
      join(repo.project, "frame_input_window.gd"),
      "extends Node\n# dirty without Host filter execution\n",
    );

    await expect(
      preflightCleanGitSubtree(requestFor(repo)),
    ).rejects.toMatchObject({ code: "source_not_clean" });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on a non-UTF-8 Git filter key before status execution", async () => {
    const repo = await createCommittedFixtureRepository();
    await writeFile(
      join(repo.project, ".gitattributes"),
      Buffer.concat([
        Buffer.from("*.gd filter=x", "utf8"),
        Buffer.from([0xff]),
        Buffer.from("\n", "utf8"),
      ]),
    );
    await commitAll(repo.root, "raw filter attributes");
    const marker = join(repo.container, "raw-filter-ran");
    await appendFile(
      join(repo.root, ".git", "config"),
      Buffer.concat([
        Buffer.from('\n[filter "x', "utf8"),
        Buffer.from([0xff]),
        Buffer.from(`"]\n\tclean = /usr/bin/touch ${marker}\n`, "utf8"),
      ]),
    );
    await writeFile(
      join(repo.project, "frame_input_window.gd"),
      "extends Node\n# raw filter must not run\n",
    );

    await expect(
      preflightCleanGitSubtree(requestFor(repo)),
    ).rejects.toMatchObject({ code: "source_feature_unsupported" });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows ignored cache while excluding it from the selected tree", async () => {
    const repo = await createCommittedFixtureRepository();
    await writeFile(join(repo.root, ".gitignore"), "game/.godot/\n");
    await commitAll(repo.root, "ignore cache");
    await mkdir(join(repo.project, ".godot"));
    await writeFile(join(repo.project, ".godot", "cache"), "ignored\n");

    const source = await preflightCleanGitSubtree(requestFor(repo));

    expect(
      source.entries.some((entry) => entry.relativePath === ".godot/cache"),
    ).toBe(false);
  });

  it("rejects an unborn HEAD", async () => {
    const repo = await createCommittedFixtureRepository();
    const unbornRoot = join(repo.container, "unborn");
    await mkdir(unbornRoot);
    await cp(trustedFixtureRoot, unbornRoot, { recursive: true });
    await git(unbornRoot, ["init", "--quiet", "--initial-branch=main"]);

    await expect(
      preflightCleanGitSubtree({
        projectPath: unbornRoot,
        trustedFixtureRoot,
        sourceRepositoryExclusionRoots: [repo.runtimeRoot],
      }),
    ).rejects.toMatchObject({ code: "source_feature_unsupported" });
  });

  it("rejects an untracked manifest even when it is ignored", async () => {
    const repo = await createCommittedFixtureRepository();
    await git(repo.root, [
      "rm",
      "--quiet",
      "--cached",
      "--",
      "game/chronorift.fixture.json",
    ]);
    await writeFile(
      join(repo.root, ".gitignore"),
      "game/chronorift.fixture.json\n",
    );
    await commitAll(repo.root, "untrack manifest");

    await expect(
      preflightCleanGitSubtree(requestFor(repo)),
    ).rejects.toMatchObject({ code: "source_feature_unsupported" });
  });

  it("rejects a tracked symlink", async () => {
    const repo = await createCommittedFixtureRepository();
    await symlink("project.godot", join(repo.project, "linked-project"));
    await commitAll(repo.root, "symlink");

    await expect(
      preflightCleanGitSubtree(requestFor(repo)),
    ).rejects.toMatchObject({ code: "source_feature_unsupported" });
  });

  it("rejects a Git LFS pointer", async () => {
    const repo = await createCommittedFixtureRepository();
    await writeFile(
      join(repo.project, "frame_input_window.gd"),
      [
        "version https://git-lfs.github.com/spec/v1",
        "oid sha256:" + "a".repeat(64),
        "size 123",
        "",
      ].join("\n"),
    );
    await commitAll(repo.root, "lfs pointer");

    await expect(
      preflightCleanGitSubtree(requestFor(repo)),
    ).rejects.toMatchObject({ code: "source_feature_unsupported" });
  });

  it("rejects a tracked submodule", async () => {
    const repo = await createCommittedFixtureRepository();
    const child = join(repo.container, "child-repository");
    await mkdir(child);
    await git(child, ["init", "--quiet", "--initial-branch=main"]);
    await writeFile(join(child, "child.txt"), "child\n");
    await commitAll(child, "child");
    await git(repo.root, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--quiet",
      child,
      "game/submodule",
    ]);
    await commitAll(repo.root, "submodule");

    await expect(
      preflightCleanGitSubtree(requestFor(repo)),
    ).rejects.toMatchObject({ code: "source_feature_unsupported" });
  });

  it("rejects overlap with a task or runtime root", async () => {
    const repo = await createCommittedFixtureRepository();

    await expect(
      preflightCleanGitSubtree({
        ...requestFor(repo),
        sourceRepositoryExclusionRoots: [repo.project],
      }),
    ).rejects.toMatchObject({ code: "path_denied" });
  });

  it("rejects a blob stream that does not match frozen tree metadata", async () => {
    class CorruptingBlobGit extends NodeHostGitPort {
      public override async streamBlob(
        input: Parameters<NodeHostGitPort["streamBlob"]>[0],
      ): ReturnType<NodeHostGitPort["streamBlob"]> {
        const receipt = await super.streamBlob(input);
        const byteLength = Math.max(0, receipt.byteLength - 1);
        await input.destination.truncate(byteLength);
        return { ...receipt, byteLength };
      }
    }
    const repo = await createCommittedFixtureRepository();

    await expect(
      preflightCleanGitSubtree(requestFor(repo), {
        git: new CorruptingBlobGit(),
      }),
    ).rejects.toMatchObject({ code: "source_feature_unsupported" });
  });
});

describe("preflightCleanExternalGodotProject", () => {
  it("accepts a clean root project without a ChronoRift fixture manifest", async () => {
    const repo = await createCommittedFixtureRepository({
      projectDirectory: "",
    });
    await unlink(join(repo.root, "chronorift.fixture.json"));
    await commitAll(repo.root, "external project");

    const source = await preflightCleanExternalGodotProject(
      await externalRequestFor(repo),
    );

    expect(source.sourceKind).toBe("godot-external-lifecycle-v1");
    expect(source.projectPrefix).toBe("");
    expect(source.projectCapability.baselineSelectedTreeSha256).toBe(
      source.selectedTreeSha256,
    );
    expect(source.projectCapability.sourceRevision).toBe(source.headCommit);
    expect(source.projectCapability.declaredSourceUrl).toBe(
      externalDescriptor.declaredSourceUrl,
    );
  });

  it("rejects a nested project and reserved source roots", async () => {
    const nested = await createCommittedFixtureRepository();
    await expect(
      preflightCleanExternalGodotProject(await externalRequestFor(nested)),
    ).rejects.toMatchObject({ code: "source_feature_unsupported" });

    const reserved = await createCommittedFixtureRepository({
      projectDirectory: "",
    });
    await unlink(join(reserved.root, "chronorift.fixture.json"));
    await mkdir(join(reserved.root, "addons"));
    await writeFile(
      join(reserved.root, "addons", "plugin.gd"),
      "extends Node\n",
    );
    await commitAll(reserved.root, "reserved root");
    await expect(
      preflightCleanExternalGodotProject(await externalRequestFor(reserved)),
    ).rejects.toMatchObject({ code: "source_feature_unsupported" });

    const reservedOverride = await createCommittedFixtureRepository({
      projectDirectory: "",
    });
    await unlink(join(reservedOverride.root, "chronorift.fixture.json"));
    await writeFile(
      join(reservedOverride.root, "override.cfg"),
      "[autoload]\n",
    );
    await commitAll(reservedOverride.root, "reserved override");
    await expect(
      preflightCleanExternalGodotProject(
        await externalRequestFor(reservedOverride),
      ),
    ).rejects.toMatchObject({ code: "source_feature_unsupported" });
  });

  it("rejects a descriptor stored inside the source repository", async () => {
    const repo = await createCommittedFixtureRepository({
      projectDirectory: "",
    });
    await unlink(join(repo.root, "chronorift.fixture.json"));
    await commitAll(repo.root, "external project");
    const descriptorPath = join(repo.root, "operator.json");
    await writeFile(descriptorPath, `${JSON.stringify(externalDescriptor)}\n`);
    const descriptorSnapshot =
      await readGodotProjectDescriptorSnapshotV1(descriptorPath);

    await expect(
      preflightCleanExternalGodotProject({
        projectPath: repo.root,
        descriptorSnapshot,
        sourceRepositoryExclusionRoots: [repo.runtimeRoot],
      }),
    ).rejects.toMatchObject({ code: "path_denied" });
  });

  it("requires a configured main scene and rejects the reserved lifecycle autoload", async () => {
    const missingMain = await createCommittedFixtureRepository({
      projectDirectory: "",
    });
    await unlink(join(missingMain.root, "chronorift.fixture.json"));
    await writeFile(
      join(missingMain.root, "project.godot"),
      '[application]\nconfig/name="External"\n',
    );
    await commitAll(missingMain.root, "missing main scene");
    await expect(
      preflightCleanExternalGodotProject(await externalRequestFor(missingMain)),
    ).rejects.toMatchObject({ code: "source_feature_unsupported" });

    const reservedAutoload = await createCommittedFixtureRepository({
      projectDirectory: "",
    });
    await unlink(join(reservedAutoload.root, "chronorift.fixture.json"));
    await writeFile(
      join(reservedAutoload.root, "project.godot"),
      '[application]\nrun/main_scene="res://main.tscn"\n\n[autoload]\nChronoRiftLifecycle="*res://probe.gd"\n',
    );
    await commitAll(reservedAutoload.root, "reserved autoload");
    await expect(
      preflightCleanExternalGodotProject(
        await externalRequestFor(reservedAutoload),
      ),
    ).rejects.toMatchObject({ code: "source_feature_unsupported" });
  });
});

describe("preflightCleanProjectEnvironmentV1", () => {
  const createProject = async (): Promise<FixtureRepository> => {
    const repo = await createCommittedFixtureRepository({
      projectDirectory: "",
    });
    await unlink(join(repo.root, "chronorift.fixture.json"));
    await commitAll(repo.root, "PE-A project");
    return repo;
  };

  it("discovers a clean repository-root project without a descriptor", async () => {
    const repo = await createProject();

    const source = await preflightCleanProjectEnvironmentV1({
      projectPath: repo.root,
      sourceRepositoryExclusionRoots: [repo.runtimeRoot],
    });

    expect(source).toMatchObject({
      sourceKind: "project-environment-v1-clean-git",
      projectPrefix: "",
      requestedGodotVersion: "4.7.1",
    });
    expect(source.mainScene).toMatch(/^(?:res|uid):\/\//u);
    expect(source.projectSourceIdentity).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("accepts only the exact PE-A Godot patch request", async () => {
    const accepted = await createProject();
    await writeFile(join(accepted.root, ".godot-version"), "4.7.1\n");
    await commitAll(accepted.root, "pin Godot");
    await expect(
      preflightCleanProjectEnvironmentV1({
        projectPath: accepted.root,
        sourceRepositoryExclusionRoots: [accepted.runtimeRoot],
      }),
    ).resolves.toMatchObject({ requestedGodotVersion: "4.7.1" });

    const rejected = await createProject();
    await writeFile(join(rejected.root, ".godot-version"), "4.7.2\n");
    await commitAll(rejected.root, "wrong Godot patch");
    await expect(
      preflightCleanProjectEnvironmentV1({
        projectPath: rejected.root,
        sourceRepositoryExclusionRoots: [rejected.runtimeRoot],
      }),
    ).rejects.toMatchObject({ code: "source_feature_unsupported" });
  });

  it.each([
    ["credential-like source", ".env.production", "SECRET=value\n"],
    ["tool script", "tool_script.gd", "@tool\nextends Node\n"],
    [
      "editor plugin",
      "editor_plugin.gd",
      "extends EditorPlugin\nfunc _enter_tree():\n\tpass\n",
    ],
  ])("rejects %s", async (_label, relativePath, contents) => {
    const repo = await createProject();
    await writeFile(join(repo.root, relativePath), contents);
    await commitAll(repo.root, `add ${relativePath}`);

    await expect(
      preflightCleanProjectEnvironmentV1({
        projectPath: repo.root,
        sourceRepositoryExclusionRoots: [repo.runtimeRoot],
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("rejects a nested project and a dirty worktree", async () => {
    const nested = await createCommittedFixtureRepository();
    await expect(
      preflightCleanProjectEnvironmentV1({
        projectPath: nested.project,
        sourceRepositoryExclusionRoots: [nested.runtimeRoot],
      }),
    ).rejects.toMatchObject({ code: "source_feature_unsupported" });

    const dirty = await createProject();
    await appendFile(join(dirty.root, "project.godot"), "\n# dirty\n");
    await expect(
      preflightCleanProjectEnvironmentV1({
        projectPath: dirty.root,
        sourceRepositoryExclusionRoots: [dirty.runtimeRoot],
      }),
    ).rejects.toMatchObject({ code: "source_not_clean" });
  });
});
