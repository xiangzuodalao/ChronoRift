import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { GitSourceRef } from "@chronorift/domain";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}

async function tryGit(
  cwd: string,
  args: readonly string[],
): Promise<string | null> {
  try {
    return await runGit(cwd, args);
  } catch {
    return null;
  }
}

/** Captures a commit plus a hash of tracked diffs and untracked file contents. */
export async function collectGitSourceRef(cwd: string): Promise<GitSourceRef> {
  const inside = await tryGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside?.trim() !== "true") {
    return { commit: null, dirty: true, worktreePatchHash: null };
  }

  const commitOutput = await tryGit(cwd, ["rev-parse", "HEAD"]);
  const commit = commitOutput?.trim() || null;
  const status = await runGit(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (status.length === 0) {
    return { commit, dirty: false, worktreePatchHash: null };
  }

  const hash = createHash("sha256");
  hash.update(status);
  hash.update((await tryGit(cwd, ["diff", "--binary", "--no-ext-diff"])) ?? "");
  hash.update(
    (await tryGit(cwd, ["diff", "--cached", "--binary", "--no-ext-diff"])) ??
      "",
  );

  const records = status.split("\0").filter((record) => record.length > 0);
  for (const record of records) {
    if (!record.startsWith("?? ")) continue;
    const relativePath = record.slice(3);
    hash.update(relativePath);
    try {
      hash.update(await readFile(resolve(cwd, relativePath)));
    } catch (error) {
      hash.update(error instanceof Error ? error.name : "unreadable");
    }
  }

  return {
    commit,
    dirty: true,
    worktreePatchHash: hash.digest("hex"),
  };
}
