import { isAbsolute } from "node:path";

import type {
  CodingToolResult,
  VNextCodingToolPort,
} from "@chronorift/pi-harness";

import type {
  SrtCommandResult,
  SrtSandboxController,
} from "./srt-sandbox-controller.js";

export interface SandboxPiCodingToolPaths {
  readonly workspacePath: string;
  readonly homePath: string;
  readonly tempPath: string;
  readonly artifactsPath: string;
}

const assertAbsolutePath = (path: string, label: string): void => {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new TypeError(`${label} must be an absolute path without NUL bytes`);
  }
};

const relativeWorkspacePath = (path: string, allowDot = false): string => {
  if (allowDot && path === ".") return path;
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("invalid relative workspace path");
  }
  return path;
};

const boundedLines = (
  bytes: Uint8Array,
  limit: number,
): {
  readonly stdout: Uint8Array;
  readonly resultLimitReached?: number | undefined;
} => {
  const value = Buffer.from(bytes).toString("utf8");
  const allLines = value.endsWith("\n")
    ? value.slice(0, -1).split("\n")
    : value.split("\n");
  const selected = allLines.slice(0, limit).join("\n");
  return {
    stdout: Buffer.from(selected, "utf8"),
    ...(allLines.length <= limit ? {} : { resultLimitReached: limit }),
  };
};

const commandStatus = (
  result: SrtCommandResult,
): CodingToolResult["status"] => {
  if (result.status === "timed_out") return "timed_out";
  if (result.status === "cancelled") return "cancelled";
  return result.exitCode === 0 ? "succeeded" : "failed";
};

export class SandboxPiCodingToolPort implements VNextCodingToolPort {
  public constructor(
    private readonly controller: Pick<SrtSandboxController, "runCoding">,
    private readonly paths: SandboxPiCodingToolPaths,
  ) {
    assertAbsolutePath(paths.workspacePath, "workspacePath");
    assertAbsolutePath(paths.homePath, "homePath");
    assertAbsolutePath(paths.tempPath, "tempPath");
    assertAbsolutePath(paths.artifactsPath, "artifactsPath");
  }

  private async execute(
    argv: readonly [string, ...string[]],
    input: {
      readonly timeoutMs?: number | undefined;
      readonly stdin?: Uint8Array | undefined;
      readonly signal?: AbortSignal | undefined;
      readonly onOutput?: ((chunk: Uint8Array) => void) | undefined;
    } = {},
  ): Promise<CodingToolResult> {
    const result = await this.controller.runCoding({
      argv,
      cwd: this.paths.workspacePath,
      workspacePath: this.paths.workspacePath,
      homePath: this.paths.homePath,
      tempPath: this.paths.tempPath,
      artifactsPath: this.paths.artifactsPath,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.stdin === undefined
        ? {}
        : { stdin: Uint8Array.from(input.stdin) }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.onOutput === undefined ? {} : { onOutput: input.onOutput }),
    });
    return {
      stdout: Buffer.from(result.stdout, "utf8"),
      stderr: Buffer.from(result.stderr, "utf8"),
      exitCode: result.exitCode,
      status: commandStatus(result),
    };
  }

  public read(path: string, signal?: AbortSignal): Promise<CodingToolResult> {
    return this.execute(["/usr/bin/cat", "--", relativeWorkspacePath(path)], {
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public bash(
    command: string,
    options: Parameters<VNextCodingToolPort["bash"]>[1],
  ): Promise<CodingToolResult> {
    return this.execute(["/bin/bash", "-c", command], options);
  }

  public write(
    path: string,
    content: Uint8Array,
    signal?: AbortSignal,
  ): Promise<CodingToolResult> {
    const target = relativeWorkspacePath(path);
    return this.execute(
      [
        "/bin/bash",
        "-c",
        'set -eu; target="$1"; case "$target" in */*) parent="${target%/*}"; /usr/bin/mkdir -p -- "$parent";; esac; temporary="${target}.chronorift-tmp-$$"; trap \'/usr/bin/rm -f -- "$temporary"\' EXIT; /usr/bin/cat >"$temporary"; /usr/bin/mv -f -- "$temporary" "$target"; trap - EXIT',
        "chronorift-write",
        target,
      ],
      {
        stdin: content,
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }

  public async grep(
    request: Parameters<VNextCodingToolPort["grep"]>[0],
    signal?: AbortSignal,
  ): Promise<CodingToolResult> {
    const args = ["/usr/bin/rg", "--line-number", "--color=never"];
    if (request.ignoreCase) args.push("--ignore-case");
    if (request.literal) args.push("--fixed-strings");
    if (request.context > 0) args.push("--context", String(request.context));
    if (request.glob !== undefined) args.push("--glob", request.glob);
    args.push("--", request.pattern, relativeWorkspacePath(request.path, true));
    const result = await this.execute(args as [string, ...string[]], {
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.status === "failed" && result.exitCode === 1) {
      return { ...result, status: "succeeded", stdout: new Uint8Array() };
    }
    return { ...result, ...boundedLines(result.stdout, request.limit) };
  }

  public async find(
    request: Parameters<VNextCodingToolPort["find"]>[0],
    signal?: AbortSignal,
  ): Promise<CodingToolResult> {
    const result = await this.execute(
      [
        "/usr/bin/find",
        relativeWorkspacePath(request.path, true),
        "-type",
        "f",
        "-name",
        request.pattern,
        "-print",
      ],
      { ...(signal === undefined ? {} : { signal }) },
    );
    return { ...result, ...boundedLines(result.stdout, request.limit) };
  }

  public async ls(
    request: Parameters<VNextCodingToolPort["ls"]>[0],
    signal?: AbortSignal,
  ): Promise<CodingToolResult> {
    const result = await this.execute(
      ["/usr/bin/ls", "-1Ap", "--", relativeWorkspacePath(request.path, true)],
      { ...(signal === undefined ? {} : { signal }) },
    );
    return { ...result, ...boundedLines(result.stdout, request.limit) };
  }
}
