import { createHash, randomUUID } from "node:crypto";

import { asSha256DigestV1 } from "@chronorift/domain";
import type {
  BrokerToolResult,
  VNextCodingToolPort,
} from "@chronorift/pi-harness";

import type { SandboxExecutionRequestV1 } from "./contracts.js";
import type {
  SandboxExecutionOptionsV1,
  SandboxExecutionResultV1,
  TaskSandboxBrokerV1,
} from "./sandbox-broker.js";

const workspacePath = (path: string, allowDot = false): string => {
  if (allowDot && path === ".") return "/workspace";
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("invalid relative workspace path");
  }
  return `/workspace/${path}`;
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

export class SandboxPiCodingToolPort implements VNextCodingToolPort {
  public constructor(private readonly broker: TaskSandboxBrokerV1) {}

  private async execute(
    argv: readonly [string, ...string[]],
    input: {
      readonly timeoutMs?: number | undefined;
      readonly stdin?: Uint8Array | undefined;
      readonly signal?: AbortSignal | undefined;
      readonly onOutput?: ((chunk: Uint8Array) => void) | undefined;
    } = {},
  ): Promise<BrokerToolResult> {
    const stdin =
      input.stdin === undefined ? undefined : Uint8Array.from(input.stdin);
    const request: SandboxExecutionRequestV1 = {
      schemaVersion: 1,
      operationId: `pi-tool:${randomUUID()}`,
      profile: "coding-default",
      argv,
      cwd: "/workspace",
      environment: {},
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(stdin === undefined
        ? {}
        : {
            stdin: {
              byteLength: stdin.byteLength,
              sha256: asSha256DigestV1(
                createHash("sha256").update(stdin).digest("hex"),
              ),
            },
          }),
    };
    const options: SandboxExecutionOptionsV1 = {
      ...(stdin === undefined ? {} : { stdin }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.onOutput === undefined
        ? {}
        : {
            onStdoutChunk: input.onOutput,
            onStderrChunk: input.onOutput,
          }),
    };
    return this.toToolResult(await this.broker.execute(request, options));
  }

  private toToolResult(result: SandboxExecutionResultV1): BrokerToolResult {
    if (result.kind === "denied") {
      return {
        stdout: new Uint8Array(),
        stderr: Buffer.from(result.securityEvent.message, "utf8"),
        exitCode: null,
        status: "denied",
        receipt: result.securityEvent,
      };
    }
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.receipt.exitCode,
      status: result.receipt.status,
      receipt: result.receipt,
    };
  }

  public read(path: string, signal?: AbortSignal): Promise<BrokerToolResult> {
    return this.execute(["/bin/busybox", "cat", "--", workspacePath(path)], {
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public bash(
    command: string,
    options: Parameters<VNextCodingToolPort["bash"]>[1],
  ): Promise<BrokerToolResult> {
    return this.execute(["/bin/bash", "-c", command], options);
  }

  public write(
    path: string,
    content: Uint8Array,
    signal?: AbortSignal,
  ): Promise<BrokerToolResult> {
    const absolutePath = workspacePath(path);
    return this.execute(
      [
        "/bin/busybox",
        "sh",
        "-c",
        'set -eu; target="$1"; parent="${target%/*}"; /bin/busybox mkdir -p -- "$parent"; temporary="${target}.chronorift-tmp-$$"; trap \'/bin/busybox rm -f -- "$temporary"\' EXIT; /bin/busybox cat >"$temporary"; /bin/busybox mv -f -- "$temporary" "$target"; trap - EXIT',
        "chronorift-write",
        absolutePath,
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
  ): Promise<BrokerToolResult> {
    const args = ["/usr/bin/rg", "--line-number", "--color=never"];
    if (request.ignoreCase) args.push("--ignore-case");
    if (request.literal) args.push("--fixed-strings");
    if (request.context > 0) args.push("--context", String(request.context));
    if (request.glob !== undefined) args.push("--glob", request.glob);
    args.push("--", request.pattern, workspacePath(request.path, true));
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
  ): Promise<BrokerToolResult> {
    const result = await this.execute(
      [
        "/usr/bin/find",
        workspacePath(request.path, true),
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
  ): Promise<BrokerToolResult> {
    const result = await this.execute(
      ["/usr/bin/ls", "-1Ap", "--", workspacePath(request.path, true)],
      { ...(signal === undefined ? {} : { signal }) },
    );
    return { ...result, ...boundedLines(result.stdout, request.limit) };
  }
}
