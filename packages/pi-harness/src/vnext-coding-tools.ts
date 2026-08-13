import { createHash } from "node:crypto";

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

import {
  ProjectEnvironmentToolCallBudgetExhaustedErrorV1,
  type ProjectEnvironmentToolCallAdmissionV1,
} from "./project-environment-tool-call-budget.js";

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

export interface VNextCodingToolDefinitionsOptionsV1 {
  readonly toolCallAdmission?:
    ProjectEnvironmentToolCallAdmissionV1 | undefined;
  readonly projectAdapterFinalizeV2?:
    { readonly adapterId: string; readonly mainScene: string } | undefined;
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
const finalizeProjectAdapterV2Schema = Type.Object({});

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

const projectAdapterSchemaPathV2 = (value: unknown): string => {
  if (typeof value !== "string")
    throw new Error("Every ProjectAdapter V2 schema path must be a string");
  const normalized = value
    .replace(/^\.\//u, "")
    .replace(/^\.chronorift\/adapter-candidate\//u, "")
    .replace(/^\/workspace\/\.chronorift\/adapter-candidate\//u, "");
  if (!normalized.startsWith("schemas/") || !normalized.endsWith(".json"))
    throw new Error(
      "Every ProjectAdapter V2 schema path must be below schemas/ and end in .json",
    );
  workspacePath(normalized);
  return normalized;
};

const projectAdapterSchemaDocumentV2 = (
  bytes: Uint8Array,
  path: string,
): { readonly schemaId: string; readonly sha256: string } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decode(bytes));
  } catch (error) {
    throw new Error(`ProjectAdapter V2 schema is not valid JSON: ${path}`, {
      cause: error,
    });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Reflect.get(parsed, "schemaVersion") !== 2 ||
    Reflect.get(parsed, "dialect") !==
      "chronorift://schemas/project-adapter-payload/v2"
  )
    throw new Error(
      `ProjectAdapter V2 schema must retain schemaVersion 2 and the V2 dialect: ${path}`,
    );
  const schemaId: unknown = Reflect.get(parsed, "schemaId");
  if (
    typeof schemaId !== "string" ||
    schemaId.length === 0 ||
    schemaId.length > 128 ||
    !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(schemaId)
  )
    throw new Error(
      `ProjectAdapter V2 schema has an invalid stable schemaId: ${path}`,
    );
  return Object.freeze({
    schemaId,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
};

const projectAdapterManifestSemanticReferencesV2 = (
  manifest: Record<string, unknown>,
  schemaIds: ReadonlySet<string>,
): void => {
  const requireArray = (name: string): unknown[] => {
    const value = manifest[name];
    if (!Array.isArray(value) || value.length === 0)
      throw new Error(
        `ProjectAdapter V2 manifest must retain a non-empty ${name} array`,
      );
    return value;
  };
  const objects = (name: string): Record<string, unknown>[] =>
    requireArray(name).map((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error(`ProjectAdapter V2 ${name} entry is not an object`);
      return value as Record<string, unknown>;
    });
  const entityTypes = objects("entityTypes");
  const stateDomains = objects("stateDomains");
  const eventTypes = objects("eventTypes");
  const references = [
    ...objects("launchTargets").map((value) => ({
      owner: `launch target ${String(value["targetId"])}`,
      schemaId: value["parametersSchemaId"],
    })),
    ...entityTypes.map((value) => ({
      owner: `entity type ${String(value["entityTypeId"])}`,
      schemaId: value["schemaId"],
    })),
    ...stateDomains.map((value) => ({
      owner: `state domain ${String(value["stateDomainId"])}`,
      schemaId: value["schemaId"],
    })),
    ...eventTypes.map((value) => ({
      owner: `event type ${String(value["eventTypeId"])}`,
      schemaId: value["schemaId"],
    })),
  ];
  for (const reference of references)
    if (
      typeof reference.schemaId !== "string" ||
      !schemaIds.has(reference.schemaId)
    )
      throw new Error(
        `ProjectAdapter V2 ${reference.owner} references missing schemaId ${String(reference.schemaId)}; align the semantic declaration with a schema document`,
      );
  if (JSON.stringify(manifest).includes("dynamic-placeholder"))
    throw new Error(
      "ProjectAdapter V2 manifest still contains dynamic-placeholder semantics; replace them with source-derived stable identifiers",
    );
};

const finalizeProjectAdapterManifestV2 = async (
  port: VNextCodingToolPort,
  binding: { readonly adapterId: string; readonly mainScene: string },
  onFinalized: () => void,
  signal?: AbortSignal,
) => {
  const manifestPath = ".chronorift/adapter-candidate/manifest.json";
  const manifestRead = await port.read(manifestPath, signal);
  const readFailure = executionFailure(manifestRead, "adapter manifest read");
  if (readFailure !== undefined) return readFailure;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decode(manifestRead.stdout));
  } catch (error) {
    throw new Error("ProjectAdapter V2 manifest is not valid JSON", {
      cause: error,
    });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Reflect.get(parsed, "schemaVersion") !== 2 ||
    !Array.isArray(Reflect.get(parsed, "schemas"))
  )
    throw new Error(
      "ProjectAdapter V2 manifest must be an object with schemaVersion 2 and a schemas array",
    );
  const manifest = parsed as Record<string, unknown>;
  manifest["adapterId"] = binding.adapterId;
  const sdk = manifest["sdk"];
  const engine = manifest["engine"];
  if (
    typeof sdk !== "object" ||
    sdk === null ||
    Array.isArray(sdk) ||
    typeof engine !== "object" ||
    engine === null ||
    Array.isArray(engine)
  )
    throw new Error(
      "ProjectAdapter V2 manifest must retain its SDK and engine structural objects",
    );
  const sdkRecord = sdk as Record<string, unknown>;
  const engineRecord = engine as Record<string, unknown>;
  sdkRecord["id"] = "chronorift-project-adapter-sdk";
  sdkRecord["version"] = 2;
  engineRecord["id"] = "godot";
  engineRecord["versionRequirement"] = "4.7.x";
  engineRecord["language"] = "gdscript";
  const launchTargets: unknown = manifest["launchTargets"];
  if (!Array.isArray(launchTargets) || launchTargets.length !== 1)
    throw new Error(
      "ProjectAdapter V2 manifest must retain exactly one launch target",
    );
  const launchTarget: unknown = launchTargets[0];
  if (
    typeof launchTarget !== "object" ||
    launchTarget === null ||
    Array.isArray(launchTarget)
  )
    throw new Error("ProjectAdapter V2 launch target is not an object");
  const launchRecord = launchTarget as Record<string, unknown>;
  launchRecord["scene"] = binding.mainScene;
  launchRecord["default"] = true;
  launchRecord["renderer"] = "headless";
  const discovered = await port.find(
    {
      pattern: "*.json",
      path: ".chronorift/adapter-candidate/schemas",
      limit: 65,
    },
    signal,
  );
  const findFailure = executionFailure(discovered, "adapter schema inventory");
  if (findFailure !== undefined) return findFailure;
  if (discovered.resultLimitReached !== undefined)
    throw new Error("ProjectAdapter V2 schema inventory exceeded 64 files");
  const physicalFiles = [
    ...new Set(
      decode(discovered.stdout)
        .split("\n")
        .map((path) => path.trim())
        .filter((path) => path.length > 0),
    ),
  ].sort();
  if (physicalFiles.length === 0 || physicalFiles.length > 64)
    throw new Error(
      "ProjectAdapter V2 candidate must contain from 1 to 64 schema files",
    );
  const declarations: {
    schemaVersion: 2;
    schemaId: string;
    path: string;
    sha256: string;
  }[] = [];
  const schemaIds = new Set<string>();
  for (const physicalPath of physicalFiles) {
    const relativePath = projectAdapterSchemaPathV2(physicalPath);
    const result = await port.read(
      `.chronorift/adapter-candidate/${relativePath}`,
      signal,
    );
    const failure = executionFailure(
      result,
      `adapter schema read (${relativePath})`,
    );
    if (failure !== undefined) return failure;
    const document = projectAdapterSchemaDocumentV2(
      result.stdout,
      relativePath,
    );
    if (schemaIds.has(document.schemaId))
      throw new Error(
        `ProjectAdapter V2 schemaId is duplicated: ${document.schemaId}`,
      );
    schemaIds.add(document.schemaId);
    declarations.push({
      schemaVersion: 2,
      schemaId: document.schemaId,
      path: relativePath,
      sha256: document.sha256,
    });
  }
  manifest["schemas"] = declarations;
  projectAdapterManifestSemanticReferencesV2(manifest, schemaIds);
  const bytes = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  const write = await port.write(manifestPath, bytes, signal);
  const writeFailure = executionFailure(write, "adapter manifest write");
  if (writeFailure !== undefined) return writeFailure;
  onFinalized();
  return {
    content: text(
      `Updated ${declarations.length} exact schema SHA-256 declaration(s), restored the Host-bound fields, and froze the ProjectAdapter V2 candidate for the remainder of this turn. Only read, grep, find, and ls remain available for review. Host validation still determines whether the candidate conforms.`,
    ),
    details: { receipt: write.receipt },
  };
};

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
  options: VNextCodingToolDefinitionsOptionsV1 = {},
): readonly ToolDefinition[] {
  let projectAdapterFinalizedV2 = false;
  const assertAdmitted = (toolName: string): void => {
    const admission = options.toolCallAdmission;
    if (admission !== undefined && !admission.tryAdmit(toolName)) {
      throw new ProjectEnvironmentToolCallBudgetExhaustedErrorV1(
        admission.limit,
      );
    }
  };
  const assertCandidateMutable = (toolName: string): void => {
    if (
      options.projectAdapterFinalizeV2 !== undefined &&
      projectAdapterFinalizedV2
    )
      throw Object.assign(
        new Error(
          `candidate_frozen: ${toolName} is unavailable after project_adapter_finalize_v2; finish the initialization turn without further mutation`,
        ),
        { code: "candidate_frozen" },
      );
  };
  const read = defineTool({
    name: "read",
    label: "read",
    description: `Read a workspace text file. Output is capped at ${DEFAULT_MAX_LINES} lines or ${Math.floor(DEFAULT_MAX_BYTES / 1024)}KB.`,
    promptSnippet: "Read file contents",
    parameters: readSchema,
    async execute(_id, input, signal) {
      assertAdmitted("read");
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
      assertAdmitted("bash");
      assertCandidateMutable("bash");
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
      assertAdmitted("write");
      assertCandidateMutable("write");
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
      assertAdmitted("edit");
      assertCandidateMutable("edit");
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
      assertAdmitted("grep");
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
      assertAdmitted("find");
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
      assertAdmitted("ls");
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
  const projectAdapterFinalizeV2 = defineTool({
    name: "project_adapter_finalize_v2",
    label: "project_adapter_finalize_v2",
    description:
      "Recompute exact SHA-256 declarations for the schemas already authored in the editable ProjectAdapter V2 candidate manifest. This does not generate semantics or run conformance.",
    promptSnippet: "Finalize ProjectAdapter V2 schema hashes",
    parameters: finalizeProjectAdapterV2Schema,
    executionMode: "sequential",
    async execute(_id, _input, signal) {
      assertAdmitted("project_adapter_finalize_v2");
      assertCandidateMutable("project_adapter_finalize_v2");
      return serializeMutation(
        ".chronorift/adapter-candidate/manifest.json",
        () =>
          finalizeProjectAdapterManifestV2(
            port,
            options.projectAdapterFinalizeV2!,
            () => {
              projectAdapterFinalizedV2 = true;
            },
            signal,
          ),
      );
    },
  });
  return Object.freeze([
    read,
    bash,
    edit,
    write,
    grep,
    find,
    ls,
    ...(options.projectAdapterFinalizeV2 === undefined
      ? []
      : [projectAdapterFinalizeV2]),
  ]);
}
