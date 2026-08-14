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
): VerifiedProjectEnvironmentSourceV1 => ({
  sourceKind: "project-environment-v1-clean-git",
  repositoryRoot: root,
  projectRoot: root,
  projectPrefix: "",
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

const cleanGit = (): HostGitPort =>
  ({
    statusPorcelain: vi.fn(async () => Buffer.alloc(0)),
  }) as unknown as HostGitPort;

describe("Project Environment project-local store preparation", () => {
  it("creates an exact self-ignored local namespace without touching root Git metadata", async () => {
    const root = await makeRoot();
    await mkdir(join(root, ".git"));
    const prepared = await prepareProjectEnvironmentProjectStoreV1(
      source(root),
      cleanGit(),
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
    const git = cleanGit();
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
        cleanGit(),
      ),
    ).rejects.toThrow(/tracked/u);

    const other = await makeRoot();
    await mkdir(join(root, "redirect"));
    await symlink(join(root, "redirect"), join(other, ".chronorift"));
    await expect(
      prepareProjectEnvironmentProjectStoreV1(source(other), cleanGit()),
    ).rejects.toThrow(/canonical non-symlink/u);
  });

  it("fails closed if the local marker does not remain ignored", async () => {
    const root = await makeRoot();
    const dirtyGit = {
      statusPorcelain: vi.fn(async () => Buffer.from("?? .chronorift/\n")),
    } as unknown as HostGitPort;
    await expect(
      prepareProjectEnvironmentProjectStoreV1(source(root), dirtyGit),
    ).rejects.toThrow(/did not preserve a clean Git worktree/u);
  });
});
