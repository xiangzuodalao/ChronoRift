import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { collectGitSourceRef } from "./git-source.js";

const execFileAsync = promisify(execFile);

describe("collectGitSourceRef", () => {
  it("fingerprints an unborn dirty worktree without inventing a commit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chronorift-git-"));
    await execFileAsync("git", ["init", "-q"], { cwd: directory });
    await writeFile(join(directory, "fixture.txt"), "first\n", "utf8");
    const first = await collectGitSourceRef(directory);
    expect(first.commit).toBeNull();
    expect(first.dirty).toBe(true);
    expect(first.worktreePatchHash).toMatch(/^[a-f0-9]{64}$/u);

    await writeFile(join(directory, "fixture.txt"), "second\n", "utf8");
    const second = await collectGitSourceRef(directory);
    expect(second.worktreePatchHash).not.toBe(first.worktreePatchHash);
  });
});
