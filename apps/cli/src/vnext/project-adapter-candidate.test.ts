import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { asAdapterId, asSha256DigestV1, asTaskId } from "@chronorift/domain";
import {
  loadProjectAdapterPackageV1,
  loadProjectAdapterPackageV2,
} from "@chronorift/godot-adapter";

import {
  PROJECT_ADAPTER_CANDIDATE_MARKER,
  PROJECT_ADAPTER_REFERENCE_RELATIVE_ROOT,
  PROJECT_ADAPTER_REFERENCE_RELATIVE_ROOT_V2,
  assertProjectEnvironmentInitializationSourceUnchangedV1,
  freezeProjectAdapterCandidateV1,
  initializeProjectAdapterCandidateWorkspaceV1,
  initializeProjectAdapterCandidateWorkspaceV2,
} from "./project-adapter-candidate.js";

const roots: string[] = [];

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-adapter-candidate-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    execFile(
      "/usr/bin/git",
      ["init", "--quiet"],
      { cwd: workspace },
      (error) =>
        error === null
          ? resolve()
          : reject(new Error(error.message, { cause: error })),
    );
  });
  const taskId = asTaskId("task_project_adapter_candidate");
  const projectSourceIdentity = asSha256DigestV1("a".repeat(64));
  const adapterId = asAdapterId("adapter.pea.reference-test");
  const mainScene = "res://main.tscn";
  const initialized = await initializeProjectAdapterCandidateWorkspaceV1({
    workspaceDirectory: workspace,
    taskId,
    projectSourceIdentity,
    adapterId,
    mainScene,
  });
  return {
    workspace,
    workspaceDirectory: workspace,
    taskId,
    projectSourceIdentity,
    adapterId,
    mainScene,
    candidate: initialized.candidateDirectory,
  };
};

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ProjectAdapter candidate workspace", () => {
  it("materializes an editable V2 scaffold that remains non-publishable until authored", async () => {
    const context = await setup();
    await import("node:fs/promises").then(({ rm }) =>
      rm(join(context.workspace, ".chronorift"), {
        recursive: true,
        force: true,
      }),
    );
    const initialized = await initializeProjectAdapterCandidateWorkspaceV2({
      workspaceDirectory: context.workspace,
      taskId: context.taskId,
      projectSourceIdentity: context.projectSourceIdentity,
      adapterId: context.adapterId,
      mainScene: context.mainScene,
    });
    const [candidate, reference] = await Promise.all([
      loadProjectAdapterPackageV2(initialized.candidateDirectory, {
        requireSingleLaunchTarget: true,
        expectedMainScene: context.mainScene,
        requireEmptyLaunchParameters: true,
      }),
      loadProjectAdapterPackageV2(
        join(
          context.workspace,
          PROJECT_ADAPTER_REFERENCE_RELATIVE_ROOT_V2,
          "templates/minimal",
        ),
        {
          requireSingleLaunchTarget: true,
          expectedMainScene: context.mainScene,
          requireEmptyLaunchParameters: true,
        },
      ),
    ]);
    expect(candidate.manifestSha256).toBe(reference.manifestSha256);
    expect(candidate.manifest.smoke.requiredDynamicTraces[0]).toMatchObject({
      entityTypeId: "dynamic-placeholder",
      minimumIncarnations: 2,
    });
    await expect(
      readFile(join(initialized.candidateDirectory, "src/project_adapter.gd"), {
        encoding: "utf8",
      }),
    ).resolves.toContain("register_entity");
    expect(
      (await lstat(join(initialized.candidateDirectory, "manifest.json")))
        .mode & 0o777,
    ).toBe(0o600);
  });

  it("is editable by normal workspace tools but excluded from the game Git diff", async () => {
    const context = await setup();
    await writeFile(
      join(context.candidate, "manifest.json"),
      '{"schemaVersion":1}\n',
    );
    await writeFile(
      join(context.candidate, "adapter.gd"),
      "extends RefCounted\n",
    );

    await expect(
      assertProjectEnvironmentInitializationSourceUnchangedV1(
        context.workspace,
      ),
    ).resolves.toBeUndefined();
    expect(
      await readFile(
        join(context.workspace, ".git", "info", "exclude"),
        "utf8",
      ),
    ).toContain("/.chronorift/");
    await expect(
      readFile(
        join(
          context.workspace,
          PROJECT_ADAPTER_REFERENCE_RELATIVE_ROOT,
          "CONTRACT.md",
        ),
        "utf8",
      ),
    ).resolves.toMatch(/twelve module records/u);
    const template = await loadProjectAdapterPackageV1(
      join(
        context.workspace,
        PROJECT_ADAPTER_REFERENCE_RELATIVE_ROOT,
        "templates/minimal",
      ),
      {
        requireSingleLaunchTarget: true,
        expectedMainScene: context.mainScene,
        requireEmptyLaunchParameters: true,
        requiredImplementedModules: [
          "lifecycle",
          "clock",
          "runtime_error",
          "entity_projection",
          "state_projection",
          "event_projection",
          "capture",
        ],
      },
    );
    expect(template.manifest.adapterId).toBe(context.adapterId);

    const frozen = await freezeProjectAdapterCandidateV1(context);
    expect(frozen.fileCount).toBe(2);
    expect(frozen.candidateSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(frozen.files.map((file) => file.relativePath)).toEqual([
      "adapter.gd",
      "manifest.json",
    ]);
  });

  it("rejects a changed ownership marker", async () => {
    const context = await setup();
    const marker = join(
      context.workspace,
      ".chronorift",
      PROJECT_ADAPTER_CANDIDATE_MARKER,
    );
    await chmod(marker, 0o600);
    await writeFile(marker, '{"schemaVersion":1}\n');
    await writeFile(join(context.candidate, "manifest.json"), "{}\n");

    await expect(freezeProjectAdapterCandidateV1(context)).rejects.toThrow(
      /ownership marker/u,
    );
  });

  it("rejects symlinks, hardlinks, and unsupported candidate files", async () => {
    const symlinkContext = await setup();
    await writeFile(join(symlinkContext.candidate, "manifest.json"), "{}\n");
    await symlink(
      join(symlinkContext.candidate, "manifest.json"),
      join(symlinkContext.candidate, "adapter.gd"),
    );
    await expect(
      freezeProjectAdapterCandidateV1(symlinkContext),
    ).rejects.toThrow(/symbolic link/u);

    const hardlinkContext = await setup();
    await writeFile(join(hardlinkContext.candidate, "manifest.json"), "{}\n");
    await link(
      join(hardlinkContext.candidate, "manifest.json"),
      join(hardlinkContext.candidate, "adapter.gd"),
    );
    expect(
      (await lstat(join(hardlinkContext.candidate, "adapter.gd"))).nlink,
    ).toBe(2);
    await expect(
      freezeProjectAdapterCandidateV1(hardlinkContext),
    ).rejects.toThrow(/physical identity/u);

    const unsupportedContext = await setup();
    await writeFile(
      join(unsupportedContext.candidate, "manifest.json"),
      "{}\n",
    );
    await writeFile(join(unsupportedContext.candidate, "native.so"), "x");
    await expect(
      freezeProjectAdapterCandidateV1(unsupportedContext),
    ).rejects.toThrow(/unsupported file type/u);
  });

  it("fails initialization when game source was edited", async () => {
    const context = await setup();
    await writeFile(join(context.workspace, "game.gd"), "extends Node\n");
    await expect(
      assertProjectEnvironmentInitializationSourceUnchangedV1(
        context.workspace,
      ),
    ).rejects.toThrow(/modified game source/u);
  });
});
