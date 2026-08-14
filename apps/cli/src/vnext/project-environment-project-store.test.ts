import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { asSha256DigestV1 } from "@chronorift/domain";

import type { HostGitPort } from "./host-git.js";
import {
  PROJECT_ENVIRONMENT_LOCAL_IGNORE_BYTES_V1,
  prepareProjectEnvironmentProjectStoreV1,
} from "./project-environment-project-store.js";
import type { VerifiedProjectEnvironmentSourceV1 } from "./source-preflight.js";

const roots: string[] = [];

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-pe-project-store-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const source = (
  root: string,
  entries: readonly { readonly relativePath: string }[] = [],
  options?: {
    readonly repositoryRoot?: string | undefined;
    readonly projectPrefix?: string | undefined;
  },
): VerifiedProjectEnvironmentSourceV1 => ({
  sourceKind: "project-environment-v1-clean-git",
  repositoryRoot: options?.repositoryRoot ?? root,
  projectRoot: root,
  projectPrefix: options?.projectPrefix ?? "",
  headCommit: "1".repeat(40),
  selectedTreeSha256: asSha256DigestV1("a".repeat(64)),
  projectSourceIdentity: asSha256DigestV1("b".repeat(64)),
  entries: entries.map((entry) => ({
    ...entry,
    mode: "100644" as const,
    objectId: "2".repeat(40),
    byteLength: 1,
  })),
  mainScene: "res://main.tscn",
  requestedGodotVersion: "4.7.1",
});

const stableGit = (status = Buffer.alloc(0)): HostGitPort =>
  ({
    statusPorcelain: vi.fn(async () => status),
  }) as unknown as HostGitPort;

describe("Project Environment project-local store preparation", () => {
  it("creates an exact self-ignored local namespace without touching root Git metadata", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".git"));
    const prepared = await prepareProjectEnvironmentProjectStoreV1(
      source(root),
      stableGit(),
    );

    expect(
      await readFile(join(root, ".chronorift", ".gitignore"), "utf8"),
    ).toBe(PROJECT_ENVIRONMENT_LOCAL_IGNORE_BYTES_V1);
    expect((await lstat(prepared.namespaceRoot)).isDirectory()).toBe(true);
    await expect(
      lstat(join(root, ".git", "info", "exclude")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("is idempotent only when the marker remains exact", async () => {
    const root = await makeRoot();
    const git = stableGit();
    await prepareProjectEnvironmentProjectStoreV1(source(root), git);
    await expect(
      prepareProjectEnvironmentProjectStoreV1(source(root), git),
    ).resolves.toMatchObject({ projectRoot: root });

    await writeFile(join(root, ".chronorift", ".gitignore"), "!secret\n");
    await expect(
      prepareProjectEnvironmentProjectStoreV1(source(root), git),
    ).rejects.toThrow(/contain exactly/u);
  });

  it("rejects tracked or symlinked local roots", async () => {
    const root = await makeRoot();
    await expect(
      prepareProjectEnvironmentProjectStoreV1(
        source(root, [{ relativePath: ".chronorift/old.json" }]),
        stableGit(),
      ),
    ).rejects.toThrow(/tracked/u);

    const other = await makeRoot();
    await mkdir(join(root, "redirect"));
    await symlink(join(root, "redirect"), join(other, ".chronorift"));
    await expect(
      prepareProjectEnvironmentProjectStoreV1(source(other), stableGit()),
    ).rejects.toThrow(/canonical non-symlink/u);
  });

  it("allows a nested project and preserves an already dirty repository status", async () => {
    const repositoryRoot = await makeRoot();
    const root = join(repositoryRoot, "games", "selected");
    await mkdir(root, { recursive: true });
    const dirtyStatus = Buffer.from(" M games/selected/main.gd\0");

    await expect(
      prepareProjectEnvironmentProjectStoreV1(
        source(root, [], {
          repositoryRoot,
          projectPrefix: "games/selected",
        }),
        stableGit(dirtyStatus),
      ),
    ).resolves.toMatchObject({ projectRoot: root });
  });

  it("fails closed if creating the local marker changes Git status", async () => {
    const root = await makeRoot();
    const changingGit = {
      statusPorcelain: vi
        .fn()
        .mockResolvedValueOnce(Buffer.from(" M main.gd\0"))
        .mockResolvedValueOnce(
          Buffer.from(" M main.gd\0?? .chronorift/.gitignore\0"),
        ),
    } as unknown as HostGitPort;
    await expect(
      prepareProjectEnvironmentProjectStoreV1(source(root), changingGit),
    ).rejects.toThrow(/changed Git worktree status/u);
  });
});
