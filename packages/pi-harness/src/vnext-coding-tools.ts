import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  generateDiffString,
  generateUnifiedPatch,
  truncateHead,
  truncateTail,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface BrokerToolResult {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly exitCode: number | null;
  readonly status:
    | "succeeded"
    | "failed"
    | "timed_out"
    | "cancelled"
    | "launch_failed"
    | "denied";
  readonly receipt: unknown;
  readonly resultLimitReached?: number | undefined;
}

export interface VNextCodingToolPort {
  read(path: string, signal?: AbortSignal): Promise<BrokerToolResult>;
  bash(
    command: string,
    options: {
      readonly timeoutMs?: number | undefined;
      readonly signal?: AbortSignal | undefined;
      readonly onOutput?: ((chunk: Uint8Array) => void) | undefined;
    },
  ): Promise<BrokerToolResult>;
  write(
    path: string,
    content: Uint8Array,
    signal?: AbortSignal,
  ): Promise<BrokerToolResult>;
  grep(
    request: {
      readonly pattern: string;
      readonly path: string;
      readonly glob?: string | undefined;
      readonly ignoreCase: boolean;
      readonly literal: boolean;
      readonly context: number;
      readonly limit: number;
    },
    signal?: AbortSignal,
  ): Promise<BrokerToolResult>;
  find(
    request: {
      readonly pattern: string;
      readonly path: string;
      readonly limit: number;
    },
    signal?: AbortSignal,
  ): Promise<BrokerToolResult>;
  ls(
    request: { readonly path: string; readonly limit: number },
    signal?: AbortSignal,
  ): Promise<BrokerToolResult>;
}

export interface BrokerToolDetails {
  readonly receipt: unknown;
  readonly truncation?: ReturnType<typeof truncateHead> | undefined;
  readonly patch?: string | undefined;
  readonly diff?: string | undefined;
  readonly firstChangedLine?: number | undefined;
  readonly resultLimitReached?: number | undefined;
}

const pathSchema = Type.String({
  description: "Path relative to the task workspace",
});
const readSchema = Type.Object({
  path: pathSchema,
  offset: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
});
const bashSchema = Type.Object({
  command: Type.String(),
  timeout: Type.Optional(Type.Number()),
});
const editSchema = Type.Object({
  path: pathSchema,
  edits: Type.Array(
    Type.Object({ oldText: Type.String(), newText: Type.String() }),
  ),
});
const writeSchema = Type.Object({ path: pathSchema, content: Type.String() });
const grepSchema = Type.Object({
  pattern: Type.String(),
  path: Type.Optional(pathSchema),
  glob: Type.Optional(Type.String()),
  ignoreCase: Type.Optional(Type.Boolean()),
  literal: Type.Optional(Type.Boolean()),
  context: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
});
const findSchema = Type.Object({
  pattern: Type.String(),
  path: Type.Optional(pathSchema),
  limit: Type.Optional(Type.Number()),
});
const lsSchema = Type.Object({
  path: Type.Optional(pathSchema),
  limit: Type.Optional(Type.Number()),
});

const text = (value: string) => [{ type: "text" as const, text: value }];
const decode = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("utf8");

function workspacePath(value: string, allowDot = false): string {
  if (allowDot && value === ".") return value;
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value
      .split("/")
      .some((part) => part === "" || part === ".." || part === ".")
  ) {
    throw new Error("Path must be a normalized relative workspace path");
  }
  return value;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

function executionFailure(result: BrokerToolResult, operation: string) {
  if (result.status === "succeeded") return undefined;
  const diagnostic =
    decode(result.stderr).trim() || decode(result.stdout).trim();
  return {
    content: text(
      `${operation} failed (${result.status}, exitCode=${String(result.exitCode)})${diagnostic ? `: ${diagnostic}` : ""}`,
    ),
    details: { receipt: result.receipt },
  };
}

const mutationTails = new Map<string, Promise<void>>();
async function serializeMutation<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = mutationTails.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  mutationTails.set(path, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (mutationTails.get(path) === tail) mutationTails.delete(path);
  }
}

function applyExactEdits(
  path: string,
  source: string,
  edits: readonly { readonly oldText: string; readonly newText: string }[],
): {
  readonly content: string;
  readonly patch: string;
  readonly diff: string;
  readonly firstChangedLine: number;
} {
  if (edits.length === 0)
    throw new Error("edits must contain at least one replacement");
  const replacements = edits.map((edit) => {
    if (edit.oldText.length === 0) throw new Error("oldText must not be empty");
    const first = source.indexOf(edit.oldText);
    if (first < 0) throw new Error(`oldText was not found in ${path}`);
    if (source.indexOf(edit.oldText, first + 1) >= 0) {
      throw new Error(`oldText must match exactly once in ${path}`);
    }
    return { ...edit, start: first, end: first + edit.oldText.length };
  });
  const ordered = [...replacements].sort(
    (left, right) => left.start - right.start,
  );
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.start < ordered[index - 1]!.end) {
      throw new Error("edits must not overlap");
    }
  }
  let content = source;
  for (const edit of [...ordered].reverse()) {
    content =
      content.slice(0, edit.start) + edit.newText + content.slice(edit.end);
  }
  const display = generateDiffString(source, content);
  if (display.firstChangedLine === undefined) {
    throw new Error("edits did not change the file");
  }
  return {
    content,
    patch: generateUnifiedPatch(path, source, content),
    diff: display.diff,
    firstChangedLine: display.firstChangedLine,
  };
}

export function createVNextCodingToolDefinitions(
  port: VNextCodingToolPort,
): readonly ToolDefinition[] {
  const read = defineTool({
    name: "read",
    label: "read",
    description: `Read a workspace text file. Output is capped at ${DEFAULT_MAX_LINES} lines or ${Math.floor(DEFAULT_MAX_BYTES / 1024)}KB.`,
    promptSnippet: "Read file contents",
    parameters: readSchema,
    async execute(_id, input, signal) {
      const path = workspacePath(input.path);
      const result = await port.read(path, signal);
      const failure = executionFailure(result, "read");
      if (failure !== undefined) return failure;
      const lines = decode(result.stdout).split("\n");
      const offset = positiveInteger(input.offset, 1, "offset");
      if (offset > lines.length)
        throw new Error(`Offset ${offset} is beyond end of file`);
      const limit =
        input.limit === undefined
          ? undefined
          : positiveInteger(input.limit, 1, "limit");
      const selected = lines
        .slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit)
        .join("\n");
      const truncation = truncateHead(selected);
      return {
        content: text(truncation.content),
        details: { receipt: result.receipt, truncation },
      };
    },
  });
  const bash = defineTool({
    name: "bash",
    label: "bash",
    description: "Run a Bash command in the isolated task workspace.",
    promptSnippet: "Run shell commands",
    parameters: bashSchema,
    async execute(_id, input, signal, onUpdate) {
      const timeoutMs =
        input.timeout === undefined
          ? undefined
          : positiveInteger(input.timeout, 1, "timeout") * 1000;
      let streamed = "";
      const result = await port.bash(input.command, {
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(signal === undefined ? {} : { signal }),
        onOutput: (chunk) => {
          streamed += decode(chunk);
          const snapshot = truncateTail(streamed);
          onUpdate?.({
            content: text(snapshot.content),
            details: { receipt: undefined, truncation: snapshot },
          });
        },
      });
      const captured = [decode(result.stdout), decode(result.stderr)]
        .filter((value) => value.length > 0)
        .join("");
      const output = streamed || captured;
      const status =
        result.status === "succeeded"
          ? ""
          : `\n\n[Command ${result.status}; exitCode=${String(result.exitCode)}]`;
      const truncation = truncateTail(output + status);
      return {
        content: text(truncation.content),
        details: { receipt: result.receipt, truncation },
      };
    },
  });
  const write = defineTool({
    name: "write",
    label: "write",
    description:
      "Create or overwrite a workspace file and create its parent directories.",
    promptSnippet: "Create or overwrite files",
    parameters: writeSchema,
    executionMode: "sequential",
    async execute(_id, input, signal) {
      const path = workspacePath(input.path);
      return serializeMutation(path, async () => {
        const result = await port.write(
          path,
          Buffer.from(input.content, "utf8"),
          signal,
        );
        const failure = executionFailure(result, "write");
        if (failure !== undefined) return failure;
        return {
          content: text(
            `Successfully wrote ${Buffer.byteLength(input.content, "utf8")} bytes to ${path}`,
          ),
          details: { receipt: result.receipt },
        };
      });
    },
  });
  const edit = defineTool({
    name: "edit",
    label: "edit",
    description:
      "Edit one workspace file using unique, non-overlapping exact text replacements.",
    promptSnippet: "Make precise file edits",
    parameters: editSchema,
    executionMode: "sequential",
    async execute(_id, input, signal) {
      const path = workspacePath(input.path);
      return serializeMutation(path, async () => {
        const before = await port.read(path, signal);
        const readFailure = executionFailure(before, "edit read");
        if (readFailure !== undefined) return readFailure;
        const applied = applyExactEdits(
          path,
          decode(before.stdout),
          input.edits,
        );
        const after = await port.write(
          path,
          Buffer.from(applied.content, "utf8"),
          signal,
        );
        const writeFailure = executionFailure(after, "edit write");
        if (writeFailure !== undefined) return writeFailure;
        return {
          content: text(
            `Successfully replaced ${input.edits.length} block(s) in ${path}.`,
          ),
          details: {
            receipt: after.receipt,
            diff: applied.diff,
            patch: applied.patch,
            firstChangedLine: applied.firstChangedLine,
          },
        };
      });
    },
  });
  const grep = defineTool({
    name: "grep",
    label: "grep",
    description: "Search workspace file contents with ripgrep semantics.",
    promptSnippet: "Search file contents",
    parameters: grepSchema,
    async execute(_id, input, signal) {
      const limit = positiveInteger(input.limit, 100, "limit");
      const result = await port.grep(
        {
          pattern: input.pattern,
          path: workspacePath(input.path ?? ".", true),
          ...(input.glob === undefined ? {} : { glob: input.glob }),
          ignoreCase: input.ignoreCase ?? false,
          literal: input.literal ?? false,
          context: input.context ?? 0,
          limit,
        },
        signal,
      );
      const failure = executionFailure(result, "grep");
      if (failure !== undefined) return failure;
      return {
        content: text(decode(result.stdout)),
        details: {
          receipt: result.receipt,
          ...(result.resultLimitReached === undefined
            ? {}
            : { resultLimitReached: result.resultLimitReached }),
        },
      };
    },
  });
  const find = defineTool({
    name: "find",
    label: "find",
    description: "Find workspace files by glob pattern.",
    promptSnippet: "Find files by name",
    parameters: findSchema,
    async execute(_id, input, signal) {
      const limit = positiveInteger(input.limit, 1000, "limit");
      const result = await port.find(
        {
          pattern: input.pattern,
          path: workspacePath(input.path ?? ".", true),
          limit,
        },
        signal,
      );
      const failure = executionFailure(result, "find");
      if (failure !== undefined) return failure;
      return {
        content: text(decode(result.stdout)),
        details: {
          receipt: result.receipt,
          ...(result.resultLimitReached === undefined
            ? {}
            : { resultLimitReached: result.resultLimitReached }),
        },
      };
    },
  });
  const ls = defineTool({
    name: "ls",
    label: "ls",
    description: "List entries in a workspace directory.",
    promptSnippet: "List directory contents",
    parameters: lsSchema,
    async execute(_id, input, signal) {
      const limit = positiveInteger(input.limit, 500, "limit");
      const result = await port.ls(
        { path: workspacePath(input.path ?? ".", true), limit },
        signal,
      );
      const failure = executionFailure(result, "ls");
      if (failure !== undefined) return failure;
      return {
        content: text(decode(result.stdout)),
        details: {
          receipt: result.receipt,
          ...(result.resultLimitReached === undefined
            ? {}
            : { resultLimitReached: result.resultLimitReached }),
        },
      };
    },
  });
  return Object.freeze([read, bash, edit, write, grep, find, ls]);
}
