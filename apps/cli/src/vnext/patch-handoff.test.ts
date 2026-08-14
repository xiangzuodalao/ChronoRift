import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  access,
  appendFile,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  asSha256DigestV1,
  asTaskId,
  type JsonValue,
  type TaskId,
} from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";
import { afterEach, describe, expect, it } from "vitest";

import {
  FixtureManifestV1Schema,
  TaskGodotProjectCapabilityV1Schema,
  type TaskFixtureCapabilityV1,
} from "./contracts.js";
import { M1Error, M1PatchExportError } from "./errors.js";
import {
  loadTrustedFixtureCatalog,
  resolveTaskFixtureCapability,
} from "./fixture-manifest.js";
import { NodeHostGitPort } from "./host-git.js";
import {
  exportTaskPatch,
  extractTaskPatch,
  type ExtractTaskPatchRequest,
  type ExtractedTaskPatch,
} from "./patch-handoff.js";
import { readTrustedSelectedTree } from "./selected-tree.js";

const executeFile = promisify(execFile);
const trustedFixtureRoot = fileURLToPath(
  new URL("../../../../fixtures/godot-frame-input-window", import.meta.url),
);
const temporaryRoots: string[] = [];
const taskId = asTaskId("task_patch_handoff");

interface PreparedFixture {
  readonly root: string;
  readonly workspaceDirectory: string;
  readonly hostBaselineGitDirectory: string;
  readonly hostOperationTemporaryDirectory: string;
  readonly exportRoot: string;
  readonly hostBaselineCommit: string;
  readonly fixtureCapability: TaskFixtureCapabilityV1;
  readonly request: ExtractTaskPatchRequest;
}

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const result = await executeFile("/usr/bin/git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return result.stdout;
};

const prepareFixture = async (): Promise<PreparedFixture> => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-patch-handoff-"));
  temporaryRoots.push(root);
  const workspaceDirectory = join(root, "workspace");
  const hostBaselineGitDirectory = join(root, "host-baseline.git");
  const hostOperationTemporaryDirectory = join(root, "host-tmp");
  const exportRoot = join(root, "exports");
  await Promise.all([
    cp(trustedFixtureRoot, workspaceDirectory, { recursive: true }),
    mkdir(hostOperationTemporaryDirectory, { mode: 0o700 }),
    mkdir(exportRoot, { mode: 0o700 }),
  ]);

  const catalog = await loadTrustedFixtureCatalog(trustedFixtureRoot);
  const manifest = FixtureManifestV1Schema.parse(
    JSON.parse(
      await readFile(
        join(workspaceDirectory, "chronorift.fixture.json"),
        "utf8",
      ),
    ),
  );
  const baselineSourceHash = await readTrustedSelectedTree(workspaceDirectory);
  const fixtureCapability = resolveTaskFixtureCapability(
    { manifest, selectedTreeSha256: baselineSourceHash },
    catalog,
  );

  await git(workspaceDirectory, ["init", "--quiet"]);
  await git(workspaceDirectory, ["config", "user.name", "ChronoRift Test"]);
  await git(workspaceDirectory, [
    "config",
    "user.email",
    "chronorift-test@invalid.local",
  ]);
  await git(workspaceDirectory, ["add", "--all"]);
  await git(workspaceDirectory, ["commit", "--quiet", "-m", "baseline"]);
  const hostBaselineCommit = (
    await git(workspaceDirectory, ["rev-parse", "HEAD"])
  ).trim();
  await git(root, [
    "clone",
    "--quiet",
    "--bare",
    workspaceDirectory,
    hostBaselineGitDirectory,
  ]);

  const request: ExtractTaskPatchRequest = {
    taskId,
    workspaceDirectory,
    hostBaselineGitDirectory,
    hostBaselineCommit,
    baselineSourceHash,
    ignoredCachePaths: fixtureCapability.ignoredCachePaths,
    fixtureCapability,
    hostOperationTemporaryDirectory,
  };
  return {
    root,
    workspaceDirectory,
    hostBaselineGitDirectory,
    hostOperationTemporaryDirectory,
    exportRoot,
    hostBaselineCommit,
    fixtureCapability,
    request,
  };
};

const createChangedPatch = async (): Promise<{
  readonly prepared: PreparedFixture;
  readonly extracted: ExtractedTaskPatch;
}> => {
  const prepared = await prepareFixture();
  await appendFile(
    join(prepared.workspaceDirectory, "frame_input_window.gd"),
    "\n# candidate\n",
  );
  return {
    prepared,
    extracted: await extractTaskPatch(prepared.request),
  };
};

const exportRequest = (
  prepared: PreparedFixture,
  extracted: ExtractedTaskPatch,
  outputPath: string,
  now: () => string = () => "2026-08-07T00:00:00.000Z",
): {
  readonly taskId: TaskId;
  readonly hostCwd: string;
  readonly outputPath: string;
  readonly extracted: ExtractedTaskPatch;
  readonly now: () => string;
} => ({
  taskId,
  hostCwd: prepared.exportRoot,
  outputPath,
  extracted,
  now,
});

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(async (root) => rm(root, { recursive: true, force: true })),
  );
});

describe("extractTaskPatch", () => {
  it("uses the external project patch policy without requiring a fixture manifest", async () => {
    const prepared = await prepareFixture();
    const { fixtureCapability: _fixtureCapability, ...common } =
      prepared.request;
    void _fixtureCapability;
    const projectCapabilityContent = {
      schemaVersion: 1 as const,
      capabilityKind: "godot-external-lifecycle-v1" as const,
      descriptorSha256: asSha256DigestV1("b".repeat(64)),
      declaredSourceUrl: "https://github.com/endlessm/moddable-platformer",
      sourceRevision: prepared.hostBaselineCommit,
      baselineSelectedTreeSha256: prepared.request.baselineSourceHash,
      projectFile: "project.godot" as const,
      engineVersion: "4.7.1-stable (official)" as const,
      scripting: "gdscript" as const,
      renderer: "gl_compatibility" as const,
      executionMode: "headless" as const,
      startup: "project-main-scene" as const,
      runtimeProfile: "chronorift-godot-lifecycle-v1" as const,
      bridgeMode: "managed-runtime-overlay" as const,
      protocolVersion: 1 as const,
      ignoredCachePaths: [".godot"] as const,
      reservedSourceRoots: [".chronorift", "addons", "override.cfg"] as const,
    };
    const projectCapability = TaskGodotProjectCapabilityV1Schema.parse({
      ...projectCapabilityContent,
      capabilitySha256: asSha256DigestV1(
        contentHash(projectCapabilityContent as unknown as JsonValue),
      ),
    });
    const request: ExtractTaskPatchRequest = {
      ...common,
      sourceKind: "godot-external-lifecycle-v1",
      projectCapability,
    };
    await rm(join(prepared.workspaceDirectory, "chronorift.fixture.json"));
    await appendFile(
      join(prepared.workspaceDirectory, "frame_input_window.gd"),
      "\n# external candidate\n",
    );

    await expect(extractTaskPatch(request)).resolves.toMatchObject({
      roundTripVerified: true,
    });

    await writeFile(
      join(prepared.workspaceDirectory, "override.cfg"),
      "[autoload]\n",
    );
    await expect(extractTaskPatch(request)).rejects.toMatchObject({
      code: "source_feature_unsupported",
    });
    await rm(join(prepared.workspaceDirectory, "override.cfg"));

    const projectConfiguration = await readFile(
      join(prepared.workspaceDirectory, "project.godot"),
    );
    await writeFile(
      join(prepared.workspaceDirectory, "project.godot"),
      '[application]\nrun/main_scene="res://main.tscn"\n\n[autoload]\nChronoRiftLifecycle="*res://probe.gd"\n',
    );
    await expect(extractTaskPatch(request)).rejects.toMatchObject({
      code: "source_feature_unsupported",
    });
    await writeFile(
      join(prepared.workspaceDirectory, "project.godot"),
      projectConfiguration,
    );

    await mkdir(join(prepared.workspaceDirectory, "addons"));
    await writeFile(
      join(prepared.workspaceDirectory, "addons", "injected.gd"),
      "extends Node\n",
    );
    await expect(extractTaskPatch(request)).rejects.toMatchObject({
      code: "source_feature_unsupported",
    });
  });

  it("rejects an oversized candidate before importing it into Host Git", async () => {
    const prepared = await prepareFixture();
    const oversized = join(prepared.workspaceDirectory, "oversized.bin");
    await writeFile(oversized, "");
    await truncate(oversized, 512 * 1024 * 1024 + 1);

    await expect(extractTaskPatch(prepared.request)).rejects.toThrow(
      /bounded M1 patch profile/u,
    );
  });

  it("counts empty directories against the bounded candidate path profile", async () => {
    const prepared = await prepareFixture();
    const directoryCount = 10_001;
    for (let offset = 0; offset < directoryCount; offset += 250) {
      await Promise.all(
        Array.from(
          { length: Math.min(250, directoryCount - offset) },
          (_, index) =>
            mkdir(
              join(
                prepared.workspaceDirectory,
                `empty-${String(offset + index).padStart(5, "0")}`,
              ),
            ),
        ),
      );
    }

    await expect(extractTaskPatch(prepared.request)).rejects.toThrow(
      /bounded M1 path profile/u,
    );
  }, 20_000);

  it("ignores workspace Git metadata and preserves add/delete/binary/mode changes", async () => {
    const prepared = await prepareFixture();
    await rm(join(prepared.workspaceDirectory, ".git"), {
      recursive: true,
      force: true,
    });
    await writeFile(join(prepared.workspaceDirectory, ".git"), "untrusted\n");
    await writeFile(
      join(prepared.workspaceDirectory, ".gitignore"),
      "new.bin\nnew-script.sh\n",
    );
    await writeFile(
      join(prepared.workspaceDirectory, "new.bin"),
      Buffer.from([0, 255, 1, 0, 2]),
    );
    const executable = join(prepared.workspaceDirectory, "new-script.sh");
    await writeFile(executable, "#!/bin/sh\necho candidate\n");
    await chmod(executable, 0o755);
    await rm(join(prepared.workspaceDirectory, "frame_input_window.tscn"));
    await appendFile(
      join(prepared.workspaceDirectory, "frame_input_window.gd"),
      "\n# candidate\n",
    );
    await mkdir(join(prepared.workspaceDirectory, ".godot"));
    await symlink(
      "/does/not/matter",
      join(prepared.workspaceDirectory, ".godot", "ignored-link"),
    );

    const extracted = await extractTaskPatch(prepared.request);
    const patch = Buffer.from(extracted.patchBytes).toString("utf8");

    expect(extracted.roundTripVerified).toBe(true);
    expect(extracted.identity.patchId).toBe(
      `patch:v1:${extracted.identity.patchHash}`,
    );
    expect(patch).toContain("GIT binary patch");
    expect(patch).toContain("deleted file mode 100644");
    expect(patch).toContain("new file mode 100755");
    expect(patch).toContain("new.bin");
    expect(patch).not.toContain("ignored-link");
  });

  it("does not execute Agent Git filters and does include Agent attributes", async () => {
    const prepared = await prepareFixture();
    const marker = join(prepared.root, "filter-ran");
    await git(prepared.workspaceDirectory, [
      "config",
      "filter.hostile.clean",
      `touch ${marker}`,
    ]);
    await writeFile(
      join(prepared.workspaceDirectory, ".gitattributes"),
      "*.gd filter=hostile\n",
    );
    await appendFile(
      join(prepared.workspaceDirectory, "frame_input_window.gd"),
      "\n# filter must not run\n",
    );

    const extracted = await extractTaskPatch(prepared.request);

    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(Buffer.from(extracted.patchBytes).toString("utf8")).toContain(
      ".gitattributes",
    );
  });

  it("accepts formatting-only manifest changes but rejects semantic escalation", async () => {
    const prepared = await prepareFixture();
    const manifestPath = join(
      prepared.workspaceDirectory,
      "chronorift.fixture.json",
    );
    const manifest = FixtureManifestV1Schema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")),
    );
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await expect(extractTaskPatch(prepared.request)).resolves.toMatchObject({
      roundTripVerified: true,
    });

    await writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        controls: {
          ...manifest.controls,
          fixedFps: { default: 120, allowed: [60, 120, 240] },
        },
      }),
    );
    await expect(extractTaskPatch(prepared.request)).rejects.toMatchObject({
      code: "source_configuration_mismatch",
    });
  });

  it("bounds captured manifest and generated patch sizes", async () => {
    const oversizedManifest = await prepareFixture();
    await writeFile(
      join(oversizedManifest.workspaceDirectory, "chronorift.fixture.json"),
      Buffer.alloc(1024 * 1024 + 1, 0x20),
    );
    await expect(
      extractTaskPatch(oversizedManifest.request),
    ).rejects.toMatchObject({ code: "source_configuration_mismatch" });

    const oversizedPatch = await prepareFixture();
    await appendFile(
      join(oversizedPatch.workspaceDirectory, "frame_input_window.gd"),
      "\n# candidate\n",
    );
    class OversizedPatchReceiptGit extends NodeHostGitPort {
      public override async streamCachedBinaryDiff(
        input: Parameters<NodeHostGitPort["streamCachedBinaryDiff"]>[0],
      ): ReturnType<NodeHostGitPort["streamCachedBinaryDiff"]> {
        const receipt = await super.streamCachedBinaryDiff(input);
        return { ...receipt, byteLength: input.maxBytes + 1 };
      }
    }
    await expect(
      extractTaskPatch(oversizedPatch.request, {
        git: new OversizedPatchReceiptGit(),
      }),
    ).rejects.toMatchObject({ code: "artifact_write_failed" });
  });

  it("rejects candidate symlinks and a missing manifest", async () => {
    const symlinked = await prepareFixture();
    await symlink(
      "frame_input_window.gd",
      join(symlinked.workspaceDirectory, "candidate-link"),
    );
    await expect(extractTaskPatch(symlinked.request)).rejects.toMatchObject({
      code: "artifact_write_failed",
    });

    const missing = await prepareFixture();
    await rm(join(missing.workspaceDirectory, "chronorift.fixture.json"));
    await expect(extractTaskPatch(missing.request)).rejects.toMatchObject({
      code: "source_configuration_mismatch",
    });
  });

  it("rejects special files and a round-trip result that differs from the candidate", async () => {
    const special = await prepareFixture();
    await executeFile("/usr/bin/mkfifo", [
      join(special.workspaceDirectory, "candidate.fifo"),
    ]);
    await expect(extractTaskPatch(special.request)).rejects.toMatchObject({
      code: "artifact_write_failed",
    });

    const mismatched = await prepareFixture();
    await appendFile(
      join(mismatched.workspaceDirectory, "frame_input_window.gd"),
      "\n# must survive round-trip\n",
    );
    class NonApplyingGit extends NodeHostGitPort {
      public override applyPatch(): ReturnType<NodeHostGitPort["applyPatch"]> {
        return Promise.resolve();
      }
    }
    await expect(
      extractTaskPatch(mismatched.request, { git: new NonApplyingGit() }),
    ).rejects.toMatchObject({ code: "artifact_write_failed" });
  });

  it("rejects a corrupt Host baseline tree during round-trip materialization", async () => {
    const prepared = await prepareFixture();
    await appendFile(
      join(prepared.workspaceDirectory, "frame_input_window.gd"),
      "\n# candidate\n",
    );
    class CorruptBaselineGit extends NodeHostGitPort {
      public override listTree(): ReturnType<NodeHostGitPort["listTree"]> {
        return Promise.resolve(Buffer.from("not-a-tree-record\0", "utf8"));
      }
    }
    await expect(
      extractTaskPatch(prepared.request, { git: new CorruptBaselineGit() }),
    ).rejects.toMatchObject({ code: "artifact_write_failed" });
  });
});

describe("exportTaskPatch", () => {
  it("publishes once with a relative path and never overwrites", async () => {
    const { prepared, extracted } = await createChangedPatch();
    await mkdir(join(prepared.exportRoot, "out"));
    const attempts = await Promise.allSettled([
      exportTaskPatch(
        exportRequest(prepared, extracted, "out/candidate.patch"),
      ),
      exportTaskPatch(
        exportRequest(prepared, extracted, "out/candidate.patch"),
      ),
    ]);

    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      await readFile(join(prepared.exportRoot, "out", "candidate.patch")),
    ).toEqual(extracted.patchBytes);
  });

  it("rejects absolute, traversal, existing, and symlink-parent targets", async () => {
    const { prepared, extracted } = await createChangedPatch();
    await expect(
      exportTaskPatch(exportRequest(prepared, extracted, "/tmp/escape.patch")),
    ).rejects.toMatchObject({ code: "patch_export_failed" });
    await expect(
      exportTaskPatch(exportRequest(prepared, extracted, "../escape.patch")),
    ).rejects.toMatchObject({ code: "patch_export_failed" });

    await writeFile(join(prepared.exportRoot, "existing.patch"), "keep\n");
    await expect(
      exportTaskPatch(exportRequest(prepared, extracted, "existing.patch")),
    ).rejects.toMatchObject({
      code: "patch_export_failed",
      targetPublished: false,
    });
    const outside = join(prepared.root, "outside");
    await mkdir(outside);
    await symlink(outside, join(prepared.exportRoot, "linked"), "dir");
    await expect(
      exportTaskPatch(
        exportRequest(prepared, extracted, "linked/escape.patch"),
      ),
    ).rejects.toMatchObject({ code: "patch_export_failed" });
  });

  it("reports targetPublished when publication succeeded before receipt failure", async () => {
    const { prepared, extracted } = await createChangedPatch();
    let failure: unknown;
    try {
      await exportTaskPatch(
        exportRequest(prepared, extracted, "published.patch", () => "invalid"),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(M1PatchExportError);
    expect(failure).toMatchObject({
      code: "patch_export_failed",
      targetPublished: true,
    });
    expect(
      await readFile(join(prepared.exportRoot, "published.patch")),
    ).toEqual(extracted.patchBytes);
  });

  it("rechecks the pinned target when a publication callback fails", async () => {
    const { prepared, extracted } = await createChangedPatch();
    const outputPath = "callback-failed.patch";
    await expect(
      exportTaskPatch({
        ...exportRequest(prepared, extracted, outputPath),
        onPublished: () => {
          throw new M1Error(
            "artifact_write_failed",
            "completion record failed",
          );
        },
      }),
    ).rejects.toMatchObject({
      code: "artifact_write_failed",
      targetPublished: true,
    });
    expect(await readFile(join(prepared.exportRoot, outputPath))).toEqual(
      extracted.patchBytes,
    );
  });

  it("does not report a post-link target as published after its bytes change", async () => {
    const { prepared, extracted } = await createChangedPatch();
    const target = join(prepared.exportRoot, "tampered.patch");
    let failure: unknown;
    try {
      await exportTaskPatch(
        exportRequest(prepared, extracted, "tampered.patch", () => {
          writeFileSync(target, "tampered\n");
          return "2026-08-07T00:00:00.000Z";
        }),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(M1PatchExportError);
    expect(failure).toMatchObject({
      code: "artifact_write_failed",
      targetPublished: false,
    });
    expect(await readFile(target, "utf8")).toBe("tampered\n");
  });

  it("rejects mutated extracted bytes before touching Host output", async () => {
    const { prepared, extracted } = await createChangedPatch();
    const corrupted: ExtractedTaskPatch = {
      ...extracted,
      patchBytes: Buffer.from("not the extracted patch"),
    };
    await expect(
      exportTaskPatch(exportRequest(prepared, corrupted, "never.patch")),
    ).rejects.toMatchObject({
      code: "artifact_write_failed",
      targetPublished: false,
    });
    await expect(
      access(join(prepared.exportRoot, "never.patch")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
