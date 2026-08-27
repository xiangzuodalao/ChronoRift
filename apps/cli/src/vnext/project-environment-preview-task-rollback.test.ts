import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as SrtRuntimeConfigModule from "./srt-runtime-config.js";
import type { ProjectEnvironmentTaskDirectoryLayout } from "./task-paths.js";
import type * as WorkspaceMaterializerModule from "./workspace-materializer.js";

const mocks = vi.hoisted(() => ({
  materialize: vi.fn(),
  resolveRuntimeConfig: vi.fn(),
}));

vi.mock("./srt-runtime-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SrtRuntimeConfigModule>()),
  resolveSrtRuntimeConfig: mocks.resolveRuntimeConfig,
}));

vi.mock("./workspace-materializer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof WorkspaceMaterializerModule>()),
  materializePrivateTaskWorkspace: mocks.materialize,
}));

import {
  runProjectEnvironmentPreviewV1,
  type ProjectEnvironmentPreviewDependenciesV1,
} from "./project-environment-preview.js";

const execFileAsync = promisify(execFile);
const fixtureRoot = fileURLToPath(
  new URL("../../../../fixtures/godot-frame-input-window", import.meta.url),
);
const temporaryRoots = new Set<string>();

const git = async (cwd: string, args: readonly string[]): Promise<void> => {
  await execFileAsync("/usr/bin/git", [...args], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "ChronoRift Preview Rollback Test",
      GIT_AUTHOR_EMAIL: "preview-rollback@chronorift.invalid",
      GIT_COMMITTER_NAME: "ChronoRift Preview Rollback Test",
      GIT_COMMITTER_EMAIL: "preview-rollback@chronorift.invalid",
    },
  });
};

const setup = async () => {
  const container = await mkdtemp(
    join(tmpdir(), "chronorift-preview-task-rollback-"),
  );
  temporaryRoots.add(container);
  const repositoryRoot = join(container, "repository");
  const projectRoot = join(repositoryRoot, "game");
  const runtimeRoot = join(container, "state");
  await Promise.all([
    mkdir(projectRoot, { recursive: true }),
    mkdir(runtimeRoot, { recursive: true }),
  ]);
  await cp(fixtureRoot, projectRoot, { recursive: true });
  await git(repositoryRoot, ["init", "--quiet", "--initial-branch=main"]);
  await git(repositoryRoot, ["add", "--all"]);
  await git(repositoryRoot, ["commit", "--quiet", "-m", "fixture"]);

  mocks.resolveRuntimeConfig.mockResolvedValue({
    stateRoot: runtimeRoot,
    nodePath: process.execPath,
    godot: {
      receipt: {},
      binding: { executablePath: "/unused/godot" },
    },
  });
  return { projectRoot, runtimeRoot };
};

const requestFor = (projectPath: string) => ({
  projectPath,
  provider: "test-provider",
  model: "test-model",
  thinkingLevel: "high" as const,
  goal: null,
});

const unusedPi: ProjectEnvironmentPreviewDependenciesV1 = {
  runPiTurn: vi.fn(() => {
    throw new Error("Pi must not run before materialization succeeds");
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
  temporaryRoots.clear();
});

describe("Project Environment Preview Task rollback", () => {
  it("removes its fresh Task namespace when materialization reports source_drift", async () => {
    const { projectRoot, runtimeRoot } = await setup();
    const drift = Object.assign(
      new Error("source_drift: source changed while materializing"),
      { code: "source_drift" as const },
    );
    mocks.materialize.mockRejectedValueOnce(drift);

    await expect(
      runProjectEnvironmentPreviewV1(requestFor(projectRoot), unusedPi),
    ).rejects.toBe(drift);

    expect(await readdir(join(runtimeRoot, "srt-tasks-v1"))).toEqual([]);
  });

  it("fails visibly and preserves unknown Task content when rollback ownership is not exact", async () => {
    const { projectRoot, runtimeRoot } = await setup();
    const materializationFailure = Object.assign(
      new Error("source_drift: source changed while materializing"),
      { code: "source_drift" as const },
    );
    mocks.materialize.mockImplementationOnce(
      async ({ layout }: { layout: ProjectEnvironmentTaskDirectoryLayout }) => {
        await writeFile(
          join(layout.taskRootDirectory, "foreign-owner-state"),
          "must survive\n",
        );
        throw materializationFailure;
      },
    );

    const caught = await runProjectEnvironmentPreviewV1(
      requestFor(projectRoot),
      unusedPi,
    ).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught).toMatchObject({ code: "artifact_write_failed" });
    const aggregate = caught as AggregateError & {
      readonly retainedTaskDirectories: readonly string[];
    };
    expect(aggregate.errors[0]).toBe(materializationFailure);
    expect(aggregate.errors[1]).toBeInstanceOf(Error);
    expect(aggregate.message).toContain("Task rollback was not completed");
    expect(aggregate.retainedTaskDirectories).toHaveLength(1);
    const retainedTaskDirectory = aggregate.retainedTaskDirectories[0];
    expect(retainedTaskDirectory).toBeDefined();
    expect(
      await readFile(
        join(retainedTaskDirectory!, "foreign-owner-state"),
        "utf8",
      ),
    ).toBe("must survive\n");
    expect(await readdir(join(runtimeRoot, "srt-tasks-v1"))).toEqual([
      retainedTaskDirectory!.split("/").at(-1),
    ]);
  });
});
