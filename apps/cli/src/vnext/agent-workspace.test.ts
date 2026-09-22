import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asTaskId } from "@chronorift/domain";
import { afterEach, describe, expect, it } from "vitest";

import {
  AgentWorkspaceManager,
  AgentWorkspaceRollbackError,
  type AgentWorkspaceManagerDependencies,
} from "./agent-workspace.js";
import { NodeHostGitPort } from "./host-git.js";

const temporaryRoots: string[] = [];

const setup = async (dependencies: AgentWorkspaceManagerDependencies = {}) => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-agent-workspace-"));
  temporaryRoots.push(root);
  const rootWorkspaceDirectory = join(root, "root-workspace");
  const resources = join(root, "resources");
  const records = join(root, "records");
  for (const path of [rootWorkspaceDirectory, resources, records])
    await mkdir(path, { mode: 0o700 });
  await writeFile(
    join(rootWorkspaceDirectory, "project.godot"),
    '[application]\nrun/main_scene="res://main.tscn"\n',
  );
  await writeFile(
    join(rootWorkspaceDirectory, "main.tscn"),
    '[gd_scene format=3]\n[node name="Main" type="Node"]\n',
  );
  await writeFile(
    join(rootWorkspaceDirectory, "first.gd"),
    "extends Node\n# initial first\n",
  );
  await writeFile(
    join(rootWorkspaceDirectory, "second.gd"),
    "extends Node\n# initial second\n",
  );
  const manager = new AgentWorkspaceManager(
    {
      rootWorkspaceDirectory,
      resourceRootDirectory: join(resources, "agents"),
      recordsDirectory: join(records, "agents"),
      taskId: asTaskId("task-agent-workspaces"),
    },
    dependencies,
  );
  return { root, rootWorkspaceDirectory, resources, records, manager };
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("AgentWorkspaceManager", () => {
  it("forks current bytes and new files with independent Git, excluding caches and candidate Git metadata", async () => {
    const prepared = await setup();
    const { rootWorkspaceDirectory: root, manager } = prepared;
    await mkdir(join(root, ".git"));
    await writeFile(
      join(root, ".git", "config"),
      '[core]\n hooksPath = /untrusted\n[filter "evil"]\n clean = touch /tmp/chronorift-should-not-run\n',
    );
    await mkdir(join(root, ".godot"));
    await writeFile(join(root, ".godot", "ignored"), "cache");
    await mkdir(join(root, ".chronorift"));
    await writeFile(join(root, ".chronorift", "ignored"), "runtime");
    await writeFile(
      join(root, "first.gd"),
      "extends Node\n# uncommitted current content\n",
    );
    await writeFile(
      join(root, "new.gd"),
      "extends Node\n# new untracked source\n",
    );
    await writeFile(join(root, "image.dat"), Buffer.from([0, 255, 17, 35]));
    await chmod(join(root, "new.gd"), 0o755);
    const binding = await manager.create("worker_a");
    expect(
      await readFile(join(binding.workspaceDirectory, ".git"), "utf8"),
    ).toContain("gitdir:");
    const listing = Buffer.from(
      await new NodeHostGitPort().listWorktrees(binding.agentGitDirectory),
    ).toString("utf8");
    expect(listing).toContain(`worktree ${binding.workspaceDirectory}`);
    expect(listing).toContain("detached");
    expect(
      Buffer.from(
        await new NodeHostGitPort().statusPorcelain(binding.workspaceDirectory),
      ).toString("utf8"),
    ).toBe("");
    expect(
      await readFile(join(binding.workspaceDirectory, "first.gd"), "utf8"),
    ).toContain("uncommitted current");
    expect(
      await readFile(join(binding.workspaceDirectory, "new.gd"), "utf8"),
    ).toContain("untracked");
    expect(
      (await lstat(join(binding.workspaceDirectory, "new.gd"))).mode & 0o111,
    ).toBe(0o111);
    expect(
      await readFile(join(binding.workspaceDirectory, "image.dat")),
    ).toEqual(Buffer.from([0, 255, 17, 35]));
    expect(
      await readFile(join(binding.agentGitDirectory, ".git", "config"), "utf8"),
    ).not.toContain("untrusted");
    expect(await readdir(binding.workspaceDirectory)).not.toContain(".godot");
    expect(await readdir(binding.workspaceDirectory)).not.toContain(
      ".chronorift",
    );
    expect((await lstat(join(root, "first.gd"))).ino).not.toBe(
      (await lstat(join(binding.workspaceDirectory, "first.gd"))).ino,
    );
    await writeFile(
      join(binding.workspaceDirectory, "first.gd"),
      "extends Node\n# worker only\n",
    );
    expect(await readFile(join(root, "first.gd"), "utf8")).toContain(
      "uncommitted current",
    );
  });

  it("freezes results and round-trip patches, then applies additions, deletion, binary and mode changes while preserving Root edits", async () => {
    const { rootWorkspaceDirectory: root, manager } = await setup();
    await writeFile(join(root, "deleted.txt"), "delete me");
    await writeFile(join(root, "binary.dat"), Buffer.from([0, 255, 0]));
    const binding = await manager.create("worker");
    const worker = binding.workspaceDirectory;
    await writeFile(
      join(worker, "first.gd"),
      "extends Node\n# worker result\n",
    );
    await writeFile(join(worker, "added.gd"), "extends Node\n");
    await chmod(join(worker, "added.gd"), 0o755);
    await rm(join(worker, "deleted.txt"));
    await writeFile(
      join(worker, "binary.dat"),
      Buffer.from([0, 23, 255, 0, 15]),
    );
    const turn = await manager.finishTurn("worker", 1);
    expect(turn).toMatchObject({
      roundTripVerified: true,
      baseSourceHash: binding.baseSourceHash,
    });
    const patch = await manager.readPatch("worker", 1);
    expect(patch.text).toContain("GIT binary patch");
    expect(patch.text).toContain("deleted.txt");
    await writeFile(
      join(worker, "first.gd"),
      "extends Node\n# later worker edits\n",
    );
    await writeFile(
      join(root, "second.gd"),
      "extends Node\n# Root unrelated edit\n",
    );
    expect(await manager.applyTurn("worker", 1)).toMatchObject({
      status: "applied",
      conflicts: [],
    });
    expect(await readFile(join(root, "first.gd"), "utf8")).toContain(
      "worker result",
    );
    expect(await readFile(join(root, "second.gd"), "utf8")).toContain(
      "Root unrelated edit",
    );
    expect(await readFile(join(root, "binary.dat"))).toEqual(
      Buffer.from([0, 23, 255, 0, 15]),
    );
    expect((await lstat(join(root, "added.gd"))).mode & 0o111).toBe(0o111);
    await expect(lstat(join(root, "deleted.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await manager.readPatch("worker", 1)).toEqual(patch);
    const page = await manager.readPatch("worker", 1, 0, 20);
    expect(page).toMatchObject({
      nextOffset: 20,
      truncated: true,
      totalBytes: turn.patchByteLength,
    });
  });

  it("rejects file conflicts without applying otherwise independent worker changes", async () => {
    const { rootWorkspaceDirectory: root, manager } = await setup();
    const worker = (await manager.create("worker")).workspaceDirectory;
    await writeFile(join(worker, "first.gd"), "extends Node\n# worker\n");
    await writeFile(
      join(worker, "second.gd"),
      "extends Node\n# worker independent\n",
    );
    await manager.finishTurn("worker", 1);
    await writeFile(join(root, "first.gd"), "extends Node\n# Root\n");
    expect(await manager.applyTurn("worker", 1)).toEqual({
      status: "conflict",
      conflicts: ["first.gd"],
    });
    expect(await readFile(join(root, "second.gd"), "utf8")).toContain(
      "initial second",
    );
    expect(await readFile(join(root, "first.gd"), "utf8")).toContain("# Root");
  });

  it("advances a worker's merge base only after application and rejects old results", async () => {
    const { rootWorkspaceDirectory: root, manager } = await setup();
    const worker = (await manager.create("worker")).workspaceDirectory;
    await writeFile(
      join(worker, "first.gd"),
      "extends Node\n# first worker revision\n",
    );
    const first = await manager.finishTurn("worker", 1);
    await manager.applyTurn("worker", 1);
    await writeFile(
      join(root, "first.gd"),
      "extends Node\n# Root revised accepted result\n",
    );
    await writeFile(
      join(worker, "second.gd"),
      "extends Node\n# second worker revision\n",
    );
    const second = await manager.finishTurn("worker", 2);
    expect(second.baseSourceHash).toBe(first.candidateSourceHash);
    expect((await manager.readPatch("worker", 2)).text).not.toContain(
      "first.gd",
    );
    expect(await manager.applyTurn("worker", 1)).toEqual({
      status: "stale",
      conflicts: [],
    });
    expect(await manager.applyTurn("worker", 2)).toMatchObject({
      status: "applied",
    });
    expect(await readFile(join(root, "first.gd"), "utf8")).toContain(
      "Root revised",
    );
    expect(await manager.applyTurn("worker", 2)).toMatchObject({
      status: "no_op",
    });
    await expect(manager.finishTurn("worker", 2)).rejects.toThrow(
      /stale|recorded/u,
    );
  });

  it("treats already realized changes as a no-op and records that merge base", async () => {
    const { rootWorkspaceDirectory: root, manager } = await setup();
    const worker = (await manager.create("worker")).workspaceDirectory;
    const content = "extends Node\n# identical realization\n";
    await writeFile(join(worker, "first.gd"), content);
    const result = await manager.finishTurn("worker", 1);
    await writeFile(join(root, "first.gd"), content);
    expect(await manager.applyTurn("worker", 1)).toMatchObject({
      status: "no_op",
    });
    expect(manager.getWorkspace("worker").baseSourceHash).toBe(
      result.candidateSourceHash,
    );
  });

  it("serializes Root application with simultaneous worker result capture", async () => {
    const { manager } = await setup();
    const worker = (await manager.create("worker")).workspaceDirectory;
    await writeFile(
      join(worker, "first.gd"),
      "extends Node\n# first revision\n",
    );
    const first = await manager.finishTurn("worker", 1);
    await writeFile(
      join(worker, "second.gd"),
      "extends Node\n# second revision\n",
    );
    const [applied, second] = await Promise.all([
      manager.applyTurn("worker", 1),
      manager.finishTurn("worker", 2),
    ]);
    expect(applied).toMatchObject({ status: "applied" });
    expect(second.baseSourceHash).toBe(first.candidateSourceHash);
    const patch = await manager.readPatch("worker", 2);
    expect(patch.text).toContain("second.gd");
    expect(patch.text).not.toContain("first.gd");
    expect(await manager.applyTurn("worker", 2)).toMatchObject({
      status: "applied",
    });
  });

  it("rejects a pending old turn when a newer result was published", async () => {
    const { manager } = await setup();
    const worker = (await manager.create("worker")).workspaceDirectory;
    await writeFile(join(worker, "first.gd"), "extends Node\n# turn one\n");
    await manager.finishTurn("worker", 1);
    await writeFile(join(worker, "first.gd"), "extends Node\n# turn two\n");
    await manager.finishTurn("worker", 2);
    expect(await manager.applyTurn("worker", 1)).toMatchObject({
      status: "stale",
    });
    expect(await manager.applyTurn("worker", 2)).toMatchObject({
      status: "applied",
    });
  });

  it("handles file-to-directory changes and rejects collisions with Root-only descendants", async () => {
    const { rootWorkspaceDirectory: root, manager } = await setup();
    await writeFile(join(root, "asset"), "old file");
    const worker = (await manager.create("worker")).workspaceDirectory;
    await rm(join(worker, "asset"));
    await mkdir(join(worker, "asset"));
    await writeFile(join(worker, "asset", "new.txt"), "new nested file");
    await manager.finishTurn("worker", 1);
    expect(await manager.applyTurn("worker", 1)).toMatchObject({
      status: "applied",
    });
    expect(await readFile(join(root, "asset", "new.txt"), "utf8")).toBe(
      "new nested file",
    );
    await rm(join(worker, "asset"), { recursive: true });
    await writeFile(join(worker, "asset"), "back to a file");
    await writeFile(join(root, "asset", "root-only.txt"), "keep me");
    await manager.finishTurn("worker", 2);
    expect(await manager.applyTurn("worker", 2)).toEqual({
      status: "conflict",
      conflicts: ["asset", "asset/root-only.txt"],
    });
    expect(await readFile(join(root, "asset", "root-only.txt"), "utf8")).toBe(
      "keep me",
    );
  });

  it("rolls back every touched file when a later mutation fails", async () => {
    let failed = false;
    const { rootWorkspaceDirectory: root, manager } = await setup({
      transactionStep: (phase, path) => {
        if (!failed && phase === "apply" && path === "second.gd") {
          failed = true;
          throw new Error("injected write failure");
        }
      },
    });
    const worker = (await manager.create("worker")).workspaceDirectory;
    await writeFile(
      join(worker, "first.gd"),
      "extends Node\n# changed first\n",
    );
    await writeFile(
      join(worker, "second.gd"),
      "extends Node\n# changed second\n",
    );
    await manager.finishTurn("worker", 1);
    await expect(manager.applyTurn("worker", 1)).rejects.toThrow(
      "injected write failure",
    );
    expect(await readFile(join(root, "first.gd"), "utf8")).toContain(
      "initial first",
    );
    expect(await readFile(join(root, "second.gd"), "utf8")).toContain(
      "initial second",
    );
    expect(manager.poisoned).toBe(false);
    expect(await manager.applyTurn("worker", 1)).toMatchObject({
      status: "applied",
    });
  });

  it.each([
    { laterWriteFails: false, outcome: "commits the complete patch" },
    { laterWriteFails: true, outcome: "rolls back a later write failure" },
  ])(
    "$outcome when cancellation arrives after mutation starts",
    async ({ laterWriteFails }) => {
      const abort = new AbortController();
      let failed = false;
      const { rootWorkspaceDirectory: root, manager } = await setup({
        transactionStep: (phase, path) => {
          if (phase !== "apply") return;
          if (path === "first.gd")
            abort.abort(new Error("Cancelled after transaction started"));
          if (laterWriteFails && !failed && path === "second.gd") {
            failed = true;
            throw new Error("injected write failure after cancellation");
          }
        },
      });
      const binding = await manager.create("worker");
      const worker = binding.workspaceDirectory;
      await writeFile(
        join(worker, "first.gd"),
        "extends Node\n# changed first\n",
      );
      await writeFile(
        join(worker, "second.gd"),
        "extends Node\n# changed second\n",
      );
      const turn = await manager.finishTurn("worker", 1);
      const application = manager.applyTurn("worker", 1, abort.signal);
      if (laterWriteFails) {
        await expect(application).rejects.toThrow(
          "injected write failure after cancellation",
        );
        expect(await readFile(join(root, "first.gd"), "utf8")).toBe(
          "extends Node\n# initial first\n",
        );
        expect(await readFile(join(root, "second.gd"), "utf8")).toBe(
          "extends Node\n# initial second\n",
        );
        expect(manager.getWorkspace("worker").baseSourceHash).toBe(
          binding.baseSourceHash,
        );
        expect(await manager.applyTurn("worker", 1)).toMatchObject({
          status: "applied",
        });
      } else {
        await expect(application).resolves.toMatchObject({ status: "applied" });
      }
      expect(abort.signal.aborted).toBe(true);
      expect(await readFile(join(root, "first.gd"), "utf8")).toBe(
        "extends Node\n# changed first\n",
      );
      expect(await readFile(join(root, "second.gd"), "utf8")).toBe(
        "extends Node\n# changed second\n",
      );
      expect(manager.getWorkspace("worker").baseSourceHash).toBe(
        turn.candidateSourceHash,
      );
      expect(manager.poisoned).toBe(false);
    },
  );

  it("poisons Root after a failed rollback and refuses more mutations", async () => {
    const { manager } = await setup({
      transactionStep: (phase, path) => {
        if (phase === "rollback" || path === "second.gd")
          throw new Error("injected failure");
      },
    });
    const worker = (await manager.create("worker")).workspaceDirectory;
    await writeFile(
      join(worker, "first.gd"),
      "extends Node\n# changed first\n",
    );
    await writeFile(
      join(worker, "second.gd"),
      "extends Node\n# changed second\n",
    );
    await manager.finishTurn("worker", 1);
    await expect(manager.applyTurn("worker", 1)).rejects.toBeInstanceOf(
      AgentWorkspaceRollbackError,
    );
    expect(manager.poisoned).toBe(true);
    await expect(manager.create("another_worker")).rejects.toBeInstanceOf(
      AgentWorkspaceRollbackError,
    );
    await expect(manager.applyTurn("worker", 1)).rejects.toBeInstanceOf(
      AgentWorkspaceRollbackError,
    );
  });

  it("rejects path escapes, source links, credential-like files and namespace reuse", async () => {
    const { rootWorkspaceDirectory: root, manager } = await setup();
    await expect(manager.create("../escape")).rejects.toThrow("identity");
    await symlink("first.gd", join(root, "linked.gd"));
    await expect(manager.create("linked_worker")).rejects.toThrow();
    await rm(join(root, "linked.gd"));
    await writeFile(join(root, ".env"), "PRIVATE=value");
    await expect(manager.create("secret_worker")).rejects.toThrow(
      /credential/u,
    );
    await rm(join(root, ".env"));
    await manager.create("worker");
    await expect(manager.create("worker")).rejects.toThrow("already exists");
    await expect(manager.readPatch("worker", 1, 0, 65_537)).rejects.toThrow(
      "bounds",
    );
  });

  it("rejects tampered immutable snapshots and patch bytes", async () => {
    const { manager } = await setup();
    const binding = await manager.create("worker");
    await writeFile(
      join(binding.workspaceDirectory, "first.gd"),
      "extends Node\n# worker result\n",
    );
    const result = await manager.finishTurn("worker", 1);
    await writeFile(
      join(binding.resourceDirectory, "turns", "1", "candidate", "first.gd"),
      "extends Node\n# forged result\n",
    );
    await expect(manager.applyTurn("worker", 1)).rejects.toThrow(
      "snapshot was modified",
    );
    const patch = await readFile(result.patchPath);
    patch[0] = patch[0] === 32 ? 33 : 32;
    await writeFile(result.patchPath, patch);
    await expect(manager.readPatch("worker", 1)).rejects.toThrow(
      "patch was modified",
    );
  });

  it("rejects directory case collisions at snapshot and integration boundaries", async () => {
    const { rootWorkspaceDirectory: root, manager } = await setup();
    await mkdir(join(root, "Assets"));
    await writeFile(join(root, "Assets", "root.txt"), "Root asset");
    const worker = (await manager.create("worker")).workspaceDirectory;
    await rm(join(worker, "Assets"), { recursive: true });
    await mkdir(join(worker, "assets"));
    await writeFile(join(worker, "assets", "worker.txt"), "Worker asset");
    await manager.finishTurn("worker", 1);
    await writeFile(join(root, "Assets", "later.txt"), "Root added this later");
    expect(await manager.applyTurn("worker", 1)).toEqual({
      status: "conflict",
      conflicts: ["Assets", "assets"],
    });
    await mkdir(join(root, "assets"));
    await writeFile(
      join(root, "assets", "other.txt"),
      "A second case spelling",
    );
    await expect(manager.create("colliding_worker")).rejects.toThrow(
      "colliding",
    );
  });

  it("cancels during baseline preparation before changing the parent workspace or merge base", async () => {
    const abort = new AbortController();
    const reason = new Error("Cancelled during baseline preparation");
    class CancelPreparationGit extends NodeHostGitPort {
      public override async commitTree(
        input: Parameters<NodeHostGitPort["commitTree"]>[0],
      ): Promise<string> {
        const commit = await super.commitTree(input);
        if (input.context.indexFile?.endsWith("next-baseline.index"))
          abort.abort(reason);
        return commit;
      }
    }
    const mutations: string[] = [];
    const { rootWorkspaceDirectory: root, manager } = await setup({
      git: new CancelPreparationGit(),
      transactionStep: (phase, path) => {
        mutations.push(`${phase}:${path}`);
      },
    });
    const binding = await manager.create("worker");
    await writeFile(
      join(binding.workspaceDirectory, "first.gd"),
      "extends Node\n# proposed worker change\n",
    );
    const turn = await manager.finishTurn("worker", 1);
    await expect(manager.applyTurn("worker", 1, abort.signal)).rejects.toThrow(
      reason,
    );
    expect(mutations).toEqual([]);
    expect(await readFile(join(root, "first.gd"), "utf8")).toBe(
      "extends Node\n# initial first\n",
    );
    expect(await readFile(join(root, "second.gd"), "utf8")).toBe(
      "extends Node\n# initial second\n",
    );
    expect(manager.getWorkspace("worker").baseSourceHash).toBe(
      binding.baseSourceHash,
    );
    expect(manager.poisoned).toBe(false);
    expect(await manager.applyTurn("worker", 1)).toMatchObject({
      status: "applied",
    });
    expect(await readFile(join(root, "first.gd"), "utf8")).toBe(
      "extends Node\n# proposed worker change\n",
    );
    expect(manager.getWorkspace("worker").baseSourceHash).toBe(
      turn.candidateSourceHash,
    );
  });

  it("detects Root drift before mutation while preserving the new Root changes", async () => {
    let root = "";
    class DriftGit extends NodeHostGitPort {
      public override async commitTree(
        input: Parameters<NodeHostGitPort["commitTree"]>[0],
      ): Promise<string> {
        const commit = await super.commitTree(input);
        if (input.context.indexFile?.endsWith("next-baseline.index"))
          await writeFile(
            join(root, "second.gd"),
            "extends Node\n# Root advanced during preparation\n",
          );
        return commit;
      }
    }
    const prepared = await setup({ git: new DriftGit() });
    root = prepared.rootWorkspaceDirectory;
    const worker = (await prepared.manager.create("worker")).workspaceDirectory;
    await writeFile(
      join(worker, "first.gd"),
      "extends Node\n# proposed worker change\n",
    );
    await prepared.manager.finishTurn("worker", 1);
    await expect(prepared.manager.applyTurn("worker", 1)).rejects.toThrow(
      "Root source changed before patch application",
    );
    expect(await readFile(join(root, "first.gd"), "utf8")).toContain(
      "initial first",
    );
    expect(await readFile(join(root, "second.gd"), "utf8")).toContain(
      "Root advanced",
    );
    expect(prepared.manager.poisoned).toBe(false);
  });

  it("forks nested workers from their parent and integrates only into that parent", async () => {
    const { manager, rootWorkspaceDirectory } = await setup();
    const parent = await manager.create("parent");
    await writeFile(
      join(parent.workspaceDirectory, "first.gd"),
      "parent edit\n",
    );
    const child = await manager.create("child", "parent");
    expect(
      await readFile(join(child.workspaceDirectory, "first.gd"), "utf8"),
    ).toBe("parent edit\n");
    await writeFile(
      join(child.workspaceDirectory, "second.gd"),
      "child edit\n",
    );
    await manager.finishTurn("child", 1);
    expect((await manager.applyTurn("child", 1)).status).toBe("applied");
    expect(
      await readFile(join(parent.workspaceDirectory, "second.gd"), "utf8"),
    ).toBe("child edit\n");
    expect(
      await readFile(join(rootWorkspaceDirectory, "second.gd"), "utf8"),
    ).toContain("initial second");
    await manager.finishTurn("parent", 1);
    await manager.applyTurn("parent", 1);
    expect(
      await readFile(join(rootWorkspaceDirectory, "second.gd"), "utf8"),
    ).toBe("child edit\n");
  });

  it("rejects overlapping roots and symlinked resource parents", async () => {
    const prepared = await setup();
    const options = {
      rootWorkspaceDirectory: prepared.rootWorkspaceDirectory,
      resourceRootDirectory: join(prepared.resources, "agents"),
      recordsDirectory: join(prepared.records, "agents"),
      taskId: asTaskId("task-agent-boundaries"),
    };
    expect(
      () =>
        new AgentWorkspaceManager({
          ...options,
          resourceRootDirectory: join(
            prepared.rootWorkspaceDirectory,
            "agents",
          ),
        }),
    ).toThrow("disjoint");
    await symlink(prepared.resources, join(prepared.root, "linked-resources"));
    const manager = new AgentWorkspaceManager({
      ...options,
      resourceRootDirectory: join(prepared.root, "linked-resources", "agents"),
    });
    await expect(manager.create("worker")).rejects.toThrow("canonical");
    expect(await readdir(prepared.resources)).toEqual([]);
  });
});
