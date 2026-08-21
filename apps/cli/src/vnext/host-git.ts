import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { once } from "node:events";

import { asSha256DigestV1, type Sha256DigestV1 } from "@chronorift/domain";

const GIT_EXECUTABLE = "/usr/bin/git";
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_ERROR_BYTES = 1024 * 1024;
const FIXED_CONFIG_ARGUMENTS = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "tag.gpgSign=false",
  "-c",
  "diff.external=",
  "-c",
  "diff.trustExitCode=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.file.allow=never",
  "-c",
  "submodule.recurse=false",
  "-c",
  "fetch.recurseSubmodules=false",
] as const;

const ALLOWED_OPERATION_ENVIRONMENT = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
]);

interface HostGitRunRequest {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly environment?: Readonly<Record<string, string>> | undefined;
  readonly maxOutputBytes?: number | undefined;
}

export interface HostGitRepositoryContext {
  readonly cwd: string;
  readonly gitDirectory?: string | undefined;
  readonly workTree?: string | undefined;
  readonly indexFile?: string | undefined;
}

export interface HostGitIndexEntry {
  readonly relativePath: string;
  readonly mode: "100644" | "100755";
  readonly objectId: string;
}

export interface HostGitPort {
  resolveRepositoryRoot(cwd: string): Promise<string>;
  resolveHeadCommit(cwd: string): Promise<string>;
  resolveHeadTree(cwd: string): Promise<string>;
  statusPorcelain(cwd: string): Promise<Uint8Array>;
  listTree(input: {
    readonly context: HostGitRepositoryContext;
    readonly treeish: string;
    readonly projectPrefix?: string | undefined;
  }): Promise<Uint8Array>;
  streamBlob(input: {
    readonly cwd: string;
    readonly objectId: string;
    readonly destination: FileHandle;
    readonly gitDirectory?: string | undefined;
    readonly workTree?: string | undefined;
  }): Promise<{ readonly byteLength: number; readonly sha256: Sha256DigestV1 }>;
  addDetachedNoCheckoutWorktree(input: {
    readonly repositoryRoot: string;
    readonly worktreePath: string;
    readonly commit: string;
  }): Promise<void>;
  removeWorktree(input: {
    readonly repositoryRoot: string;
    readonly worktreePath: string;
  }): Promise<void>;
  listWorktrees(repositoryRoot: string): Promise<Uint8Array>;
  initializeRepository(input: {
    readonly directory: string;
    readonly bare: boolean;
  }): Promise<void>;
  hashBlob(input: {
    readonly context: HostGitRepositoryContext;
    readonly source: FileHandle;
  }): Promise<string>;
  readTreeEmpty(context: HostGitRepositoryContext): Promise<void>;
  updateIndex(input: {
    readonly context: HostGitRepositoryContext;
    readonly entries: readonly HostGitIndexEntry[];
  }): Promise<void>;
  writeTree(context: HostGitRepositoryContext): Promise<string>;
  commitTree(input: {
    readonly context: HostGitRepositoryContext;
    readonly treeId: string;
  }): Promise<string>;
  setAgentBaselineHead(input: {
    readonly context: HostGitRepositoryContext;
    readonly commit: string;
  }): Promise<void>;
  streamCachedBinaryDiff(input: {
    readonly context: HostGitRepositoryContext;
    readonly baselineCommit: string;
    readonly destination: FileHandle;
    readonly maxBytes: number;
  }): Promise<{ readonly byteLength: number; readonly sha256: Sha256DigestV1 }>;
  applyPatch(input: {
    readonly context: HostGitRepositoryContext;
    readonly patch: FileHandle;
    readonly checkOnly: boolean;
  }): Promise<void>;
}

export class HostGitCommandError extends Error {
  public constructor(
    message: string,
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "HostGitCommandError";
  }
}

const assertOutputLimit = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Git output limit must be a nonnegative safe integer");
  }
};

const assertObjectId = (value: string, name: string): void => {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value)) {
    throw new TypeError(`${name} must be a 40- or 64-character object id`);
  }
};

const assertEnvironmentPath = (value: string, name: string): void => {
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new TypeError(`${name} must be an absolute path without NUL`);
  }
};

const contextEnvironment = (
  context: HostGitRepositoryContext,
): Readonly<Record<string, string>> => {
  const environment: Record<string, string> = {};
  if (context.gitDirectory !== undefined) {
    assertEnvironmentPath(context.gitDirectory, "gitDirectory");
    environment.GIT_DIR = context.gitDirectory;
  }
  if (context.workTree !== undefined) {
    assertEnvironmentPath(context.workTree, "workTree");
    environment.GIT_WORK_TREE = context.workTree;
  }
  if (context.indexFile !== undefined) {
    assertEnvironmentPath(context.indexFile, "indexFile");
    environment.GIT_INDEX_FILE = context.indexFile;
  }
  return environment;
};

const buildEnvironment = (
  isolatedHome: string,
  operationEnvironment: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    HOME: isolatedHome,
    XDG_CONFIG_HOME: isolatedHome,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
  };
  for (const [key, value] of Object.entries(operationEnvironment)) {
    if (!ALLOWED_OPERATION_ENVIRONMENT.has(key)) {
      throw new TypeError(
        `Git operation environment key ${key} is not allowed`,
      );
    }
    if (value.includes("\0")) {
      throw new TypeError(
        `Git operation environment value ${key} contains NUL`,
      );
    }
    environment[key] = value;
  }
  return environment;
};

const appendBounded = (
  chunks: Buffer[],
  chunk: Buffer,
  state: { byteLength: number },
  maximumBytes: number,
): boolean => {
  state.byteLength += chunk.byteLength;
  if (state.byteLength > maximumBytes) return false;
  chunks.push(chunk);
  return true;
};

type GitInput = Uint8Array | AsyncIterable<Uint8Array> | undefined;

const runGit = async (input: {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly maxOutputBytes: number;
  readonly standardInput?: GitInput;
}): Promise<Buffer> => {
  assertOutputLimit(input.maxOutputBytes);
  const isolatedHome = await mkdtemp(
    join(tmpdir(), "chronorift-host-git-home-"),
  );
  await chmod(isolatedHome, 0o700);
  try {
    const child = spawn(
      GIT_EXECUTABLE,
      [...FIXED_CONFIG_ARGUMENTS, ...input.args],
      {
        cwd: input.cwd,
        env: buildEnvironment(isolatedHome, input.environment),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    if (
      child.stdout === null ||
      child.stderr === null ||
      child.stdin === null
    ) {
      child.kill("SIGKILL");
      throw new Error("Git process did not expose required pipes");
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutState = { byteLength: 0 };
    const stderrState = { byteLength: 0 };
    let exceededOutputLimit = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (
        !appendBounded(stdoutChunks, chunk, stdoutState, input.maxOutputBytes)
      ) {
        exceededOutputLimit = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      appendBounded(stderrChunks, chunk, stderrState, MAX_ERROR_BYTES);
    });

    const exit = new Promise<{
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("close", (exitCode, signal) =>
        resolveExit({ exitCode, signal }),
      );
    });

    try {
      if (input.standardInput === undefined) {
        child.stdin.end();
      } else if (input.standardInput instanceof Uint8Array) {
        child.stdin.end(input.standardInput);
      } else {
        for await (const chunk of input.standardInput) {
          if (!(chunk instanceof Uint8Array)) {
            throw new TypeError("Git standard input chunks must be Uint8Array");
          }
          if (!child.stdin.write(chunk)) await once(child.stdin, "drain");
        }
        child.stdin.end();
      }
    } catch (error) {
      child.kill("SIGKILL");
      await exit.catch(() => undefined);
      throw error;
    }

    const result = await exit;
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    if (exceededOutputLimit) {
      throw new HostGitCommandError(
        "Git command exceeded its output limit",
        result.exitCode,
        result.signal,
        stderr,
      );
    }
    if (result.exitCode !== 0) {
      throw new HostGitCommandError(
        "Git command failed",
        result.exitCode,
        result.signal,
        stderr,
      );
    }
    return Buffer.concat(stdoutChunks);
  } finally {
    await rm(isolatedHome, { recursive: true, force: true });
  }
};

const decodeSingleLine = (bytes: Uint8Array, label: string): string => {
  const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!value.endsWith("\n") || value.slice(0, -1).includes("\n")) {
    throw new TypeError(`${label} must be exactly one LF-terminated line`);
  }
  const line = value.slice(0, -1);
  if (line.length === 0 || line.includes("\0")) {
    throw new TypeError(`${label} must be nonempty and contain no NUL`);
  }
  return line;
};

const fixedCommitEnvironment = {
  GIT_AUTHOR_NAME: "ChronoRift",
  GIT_AUTHOR_EMAIL: "chronorift@invalid.local",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "ChronoRift",
  GIT_COMMITTER_EMAIL: "chronorift@invalid.local",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
} as const;

export class NodeHostGitPort implements HostGitPort {
  private async run(input: HostGitRunRequest): Promise<Uint8Array> {
    return runGit({
      cwd: input.cwd,
      args: input.args,
      environment: input.environment ?? {},
      maxOutputBytes: input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    });
  }

  public async resolveRepositoryRoot(cwd: string): Promise<string> {
    return decodeSingleLine(
      await this.run({
        cwd,
        args: ["rev-parse", "--path-format=absolute", "--show-toplevel"],
      }),
      "repository root",
    );
  }

  public async resolveHeadCommit(cwd: string): Promise<string> {
    const commit = decodeSingleLine(
      await this.run({
        cwd,
        args: ["rev-parse", "--verify", "HEAD^{commit}"],
      }),
      "HEAD commit",
    );
    assertObjectId(commit, "HEAD commit");
    return commit;
  }

  public async resolveHeadTree(cwd: string): Promise<string> {
    const tree = decodeSingleLine(
      await this.run({
        cwd,
        args: ["rev-parse", "--verify", "HEAD^{tree}"],
      }),
      "HEAD tree",
    );
    assertObjectId(tree, "HEAD tree");
    return tree;
  }

  public async statusPorcelain(cwd: string): Promise<Uint8Array> {
    const effectiveRepositoryConfigKeys = await this.run({
      cwd,
      args: ["config", "--includes", "--name-only", "--null", "--list"],
      maxOutputBytes: 8 * 1024 * 1024,
    });
    const configBytes = Buffer.from(effectiveRepositoryConfigKeys);
    if (configBytes.byteLength > 0 && configBytes.at(-1) !== 0) {
      throw new TypeError("effective Git config keys are not NUL terminated");
    }
    const configKeys: string[] = [];
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (let offset = 0; offset < configBytes.byteLength;) {
      const end = configBytes.indexOf(0, offset);
      if (end < 0 || end === offset) {
        throw new TypeError("effective Git config contains an invalid key");
      }
      const rawKey = configBytes.subarray(offset, end);
      const key = decoder.decode(rawKey);
      if (!Buffer.from(key, "utf8").equals(rawKey)) {
        throw new TypeError("effective Git config key is not canonical UTF-8");
      }
      configKeys.push(key);
      offset = end + 1;
    }

    const filterNames = new Set<string>();
    for (const key of configKeys) {
      const match =
        /^filter\.(?<name>.+)\.(?:clean|smudge|process|required)$/iu.exec(key);
      if (match?.groups?.name !== undefined) {
        const name = match.groups.name;
        if (
          Buffer.byteLength(name, "utf8") > 256 ||
          /[=\u0000-\u0020\u007f]/u.test(name)
        ) {
          throw new TypeError("effective Git filter name is unsafe");
        }
        filterNames.add(name);
      } else if (/^filter\./iu.test(key)) {
        throw new TypeError("effective Git filter config key is unsupported");
      }
      if (filterNames.size > 256) {
        throw new TypeError("effective Git filter config exceeds its bound");
      }
    }
    const filterOverrides = [...filterNames]
      .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
      .flatMap((name) => [
        "-c",
        `filter.${name}.clean=`,
        "-c",
        `filter.${name}.smudge=`,
        "-c",
        `filter.${name}.process=`,
        "-c",
        `filter.${name}.required=false`,
      ]);
    const status = await this.run({
      cwd,
      args: [
        ...filterOverrides,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ],
    });
    if (status.byteLength !== 0) return status;

    const indexFlags = await this.run({
      cwd,
      args: ["ls-files", "-v", "-z", "--cached"],
    });
    const flagBytes = Buffer.from(indexFlags);
    let hasHiddenIndexState =
      flagBytes.byteLength > 0 && flagBytes.at(-1) !== 0;
    for (let offset = 0; !hasHiddenIndexState && offset < flagBytes.length;) {
      const end = flagBytes.indexOf(0, offset);
      if (end < 0) {
        hasHiddenIndexState = true;
        break;
      }
      const record = flagBytes.subarray(offset, end);
      if (record.byteLength < 3 || record[0] !== 0x48 || record[1] !== 0x20) {
        hasHiddenIndexState = true;
      }
      offset = end + 1;
    }
    return hasHiddenIndexState
      ? Buffer.from("ChronoRift rejected hidden Git index state\0", "utf8")
      : status;
  }

  public async listTree(input: {
    readonly context: HostGitRepositoryContext;
    readonly treeish: string;
    readonly projectPrefix?: string | undefined;
  }): Promise<Uint8Array> {
    assertObjectId(input.treeish, "treeish");
    const args = ["ls-tree", "-rz", "-l", "--full-tree", input.treeish];
    if (input.projectPrefix !== undefined && input.projectPrefix.length > 0) {
      if (
        input.projectPrefix.startsWith("/") ||
        input.projectPrefix.includes("\\") ||
        input.projectPrefix.includes("\0") ||
        input.projectPrefix
          .split("/")
          .some(
            (segment) => segment === "" || segment === "." || segment === "..",
          )
      ) {
        throw new TypeError(
          "projectPrefix must be a normalized relative POSIX path",
        );
      }
      args.push("--", `:(literal)${input.projectPrefix}`);
    }
    return this.run({
      cwd: input.context.cwd,
      args,
      environment: contextEnvironment(input.context),
    });
  }

  public async streamBlob(input: {
    readonly cwd: string;
    readonly objectId: string;
    readonly destination: FileHandle;
    readonly gitDirectory?: string | undefined;
    readonly workTree?: string | undefined;
  }): Promise<{
    readonly byteLength: number;
    readonly sha256: Sha256DigestV1;
  }> {
    assertObjectId(input.objectId, "blob object id");
    const isolatedHome = await mkdtemp(
      join(tmpdir(), "chronorift-host-git-home-"),
    );
    await chmod(isolatedHome, 0o700);
    try {
      const operationEnvironment = contextEnvironment({
        cwd: input.cwd,
        ...(input.gitDirectory === undefined
          ? {}
          : { gitDirectory: input.gitDirectory }),
        ...(input.workTree === undefined ? {} : { workTree: input.workTree }),
      });
      const child = spawn(
        GIT_EXECUTABLE,
        [...FIXED_CONFIG_ARGUMENTS, "cat-file", "blob", input.objectId],
        {
          cwd: input.cwd,
          env: buildEnvironment(isolatedHome, operationEnvironment),
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      if (child.stdout === null || child.stderr === null) {
        child.kill("SIGKILL");
        throw new Error("Git blob process did not expose required pipes");
      }
      const stderrChunks: Buffer[] = [];
      const stderrState = { byteLength: 0 };
      child.stderr.on("data", (chunk: Buffer) => {
        appendBounded(stderrChunks, chunk, stderrState, MAX_ERROR_BYTES);
      });
      const exit = new Promise<{
        readonly exitCode: number | null;
        readonly signal: NodeJS.Signals | null;
      }>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("close", (exitCode, signal) =>
          resolveExit({ exitCode, signal }),
        );
      });

      const hash = createHash("sha256");
      let byteLength = 0;
      try {
        for await (const value of child.stdout) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          hash.update(chunk);
          byteLength += chunk.byteLength;
          let offset = 0;
          while (offset < chunk.byteLength) {
            const result = await input.destination.write(
              chunk,
              offset,
              chunk.byteLength - offset,
              null,
            );
            if (result.bytesWritten === 0) {
              throw new Error("Git blob destination made no write progress");
            }
            offset += result.bytesWritten;
          }
        }
      } catch (error) {
        child.kill("SIGKILL");
        await exit.catch(() => undefined);
        throw error;
      }
      const result = await exit;
      if (result.exitCode !== 0) {
        throw new HostGitCommandError(
          "Git cat-file failed",
          result.exitCode,
          result.signal,
          Buffer.concat(stderrChunks).toString("utf8"),
        );
      }
      return { byteLength, sha256: asSha256DigestV1(hash.digest("hex")) };
    } finally {
      await rm(isolatedHome, { recursive: true, force: true });
    }
  }

  public async addDetachedNoCheckoutWorktree(input: {
    readonly repositoryRoot: string;
    readonly worktreePath: string;
    readonly commit: string;
  }): Promise<void> {
    assertObjectId(input.commit, "worktree commit");
    await this.run({
      cwd: input.repositoryRoot,
      args: [
        "worktree",
        "add",
        "--detach",
        "--no-checkout",
        input.worktreePath,
        input.commit,
      ],
    });
  }

  public async removeWorktree(input: {
    readonly repositoryRoot: string;
    readonly worktreePath: string;
  }): Promise<void> {
    await this.run({
      cwd: input.repositoryRoot,
      args: ["worktree", "remove", "--force", input.worktreePath],
    });
  }

  public async listWorktrees(repositoryRoot: string): Promise<Uint8Array> {
    return this.run({
      cwd: repositoryRoot,
      args: ["worktree", "list", "--porcelain"],
    });
  }

  public async initializeRepository(input: {
    readonly directory: string;
    readonly bare: boolean;
  }): Promise<void> {
    await this.run({
      cwd: input.directory,
      args: input.bare
        ? ["init", "--quiet", "--bare", "."]
        : ["init", "--quiet", "--initial-branch=chronorift-task", "."],
    });
    for (const [key, value] of [
      ["core.hooksPath", "/dev/null"],
      ["core.fsmonitor", "false"],
      ["core.untrackedCache", "false"],
      ["commit.gpgSign", "false"],
      ["tag.gpgSign", "false"],
      ["diff.external", ""],
      ["protocol.allow", "never"],
      ["submodule.recurse", "false"],
    ] as const) {
      await this.run({
        cwd: input.directory,
        args: ["config", "--local", key, value],
      });
    }
  }

  public async hashBlob(input: {
    readonly context: HostGitRepositoryContext;
    readonly source: FileHandle;
  }): Promise<string> {
    const bytes = await runGit({
      cwd: input.context.cwd,
      args: ["hash-object", "--no-filters", "-w", "--stdin"],
      environment: contextEnvironment(input.context),
      maxOutputBytes: 1024,
      standardInput: input.source.createReadStream({
        autoClose: false,
        start: 0,
      }),
    });
    const objectId = decodeSingleLine(bytes, "blob object id");
    assertObjectId(objectId, "blob object id");
    return objectId;
  }

  public async readTreeEmpty(context: HostGitRepositoryContext): Promise<void> {
    await this.run({
      cwd: context.cwd,
      args: ["read-tree", "--empty"],
      environment: contextEnvironment(context),
    });
  }

  public async updateIndex(input: {
    readonly context: HostGitRepositoryContext;
    readonly entries: readonly HostGitIndexEntry[];
  }): Promise<void> {
    const chunks: Buffer[] = [];
    for (const entry of input.entries) {
      assertObjectId(entry.objectId, "index blob object id");
      if (
        entry.relativePath.length === 0 ||
        entry.relativePath.includes("\0") ||
        entry.relativePath.includes("\\") ||
        entry.relativePath.startsWith("/")
      ) {
        throw new TypeError("index path must be a safe relative POSIX path");
      }
      chunks.push(
        Buffer.from(
          `${entry.mode} ${entry.objectId}\t${entry.relativePath}\0`,
          "utf8",
        ),
      );
    }
    await runGit({
      cwd: input.context.cwd,
      args: ["update-index", "-z", "--index-info"],
      environment: contextEnvironment(input.context),
      maxOutputBytes: 1024,
      standardInput: Buffer.concat(chunks),
    });
  }

  public async writeTree(context: HostGitRepositoryContext): Promise<string> {
    const treeId = decodeSingleLine(
      await this.run({
        cwd: context.cwd,
        args: ["write-tree"],
        environment: contextEnvironment(context),
        maxOutputBytes: 1024,
      }),
      "tree object id",
    );
    assertObjectId(treeId, "tree object id");
    return treeId;
  }

  public async commitTree(input: {
    readonly context: HostGitRepositoryContext;
    readonly treeId: string;
  }): Promise<string> {
    assertObjectId(input.treeId, "tree object id");
    const commitId = decodeSingleLine(
      await runGit({
        cwd: input.context.cwd,
        args: ["commit-tree", input.treeId],
        environment: {
          ...contextEnvironment(input.context),
          ...fixedCommitEnvironment,
        },
        maxOutputBytes: 1024,
        standardInput: Buffer.from("ChronoRift task baseline\n", "utf8"),
      }),
      "commit object id",
    );
    assertObjectId(commitId, "commit object id");
    return commitId;
  }

  public async setAgentBaselineHead(input: {
    readonly context: HostGitRepositoryContext;
    readonly commit: string;
  }): Promise<void> {
    assertObjectId(input.commit, "baseline commit");
    const environment = contextEnvironment(input.context);
    await this.run({
      cwd: input.context.cwd,
      args: ["symbolic-ref", "HEAD", "refs/heads/chronorift-task"],
      environment,
    });
    await this.run({
      cwd: input.context.cwd,
      args: ["update-ref", "refs/heads/chronorift-task", input.commit],
      environment,
    });
  }

  public async streamCachedBinaryDiff(input: {
    readonly context: HostGitRepositoryContext;
    readonly baselineCommit: string;
    readonly destination: FileHandle;
    readonly maxBytes: number;
  }): Promise<{
    readonly byteLength: number;
    readonly sha256: Sha256DigestV1;
  }> {
    assertObjectId(input.baselineCommit, "baseline commit");
    assertOutputLimit(input.maxBytes);
    const isolatedHome = await mkdtemp(
      join(tmpdir(), "chronorift-host-git-home-"),
    );
    await chmod(isolatedHome, 0o700);
    try {
      const child = spawn(
        GIT_EXECUTABLE,
        [
          ...FIXED_CONFIG_ARGUMENTS,
          "diff",
          "--cached",
          "--binary",
          "--full-index",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          input.baselineCommit,
          "--",
        ],
        {
          cwd: input.context.cwd,
          env: buildEnvironment(
            isolatedHome,
            contextEnvironment(input.context),
          ),
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      if (child.stdout === null || child.stderr === null) {
        child.kill("SIGKILL");
        throw new Error("Git diff process did not expose required pipes");
      }
      const stderrChunks: Buffer[] = [];
      const stderrState = { byteLength: 0 };
      child.stderr.on("data", (chunk: Buffer) => {
        appendBounded(stderrChunks, chunk, stderrState, MAX_ERROR_BYTES);
      });
      const exit = new Promise<{
        readonly exitCode: number | null;
        readonly signal: NodeJS.Signals | null;
      }>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("close", (exitCode, signal) =>
          resolveExit({ exitCode, signal }),
        );
      });

      const hash = createHash("sha256");
      let byteLength = 0;
      try {
        for await (const value of child.stdout) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          byteLength += chunk.byteLength;
          if (byteLength > input.maxBytes) {
            throw new HostGitCommandError(
              "Git diff exceeded its output limit",
              null,
              null,
              "",
            );
          }
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.byteLength) {
            const result = await input.destination.write(
              chunk,
              offset,
              chunk.byteLength - offset,
              null,
            );
            if (result.bytesWritten === 0) {
              throw new Error("Git diff destination made no write progress");
            }
            offset += result.bytesWritten;
          }
        }
      } catch (error) {
        child.kill("SIGKILL");
        await exit.catch(() => undefined);
        throw error;
      }
      const result = await exit;
      if (result.exitCode !== 0) {
        throw new HostGitCommandError(
          "Git diff failed",
          result.exitCode,
          result.signal,
          Buffer.concat(stderrChunks).toString("utf8"),
        );
      }
      return { byteLength, sha256: asSha256DigestV1(hash.digest("hex")) };
    } finally {
      await rm(isolatedHome, { recursive: true, force: true });
    }
  }

  public async applyPatch(input: {
    readonly context: HostGitRepositoryContext;
    readonly patch: FileHandle;
    readonly checkOnly: boolean;
  }): Promise<void> {
    await runGit({
      cwd: input.context.cwd,
      args: input.checkOnly ? ["apply", "--check", "-"] : ["apply", "-"],
      environment: contextEnvironment(input.context),
      maxOutputBytes: 8 * 1024 * 1024,
      standardInput: input.patch.createReadStream({
        autoClose: false,
        start: 0,
      }),
    });
  }
}
