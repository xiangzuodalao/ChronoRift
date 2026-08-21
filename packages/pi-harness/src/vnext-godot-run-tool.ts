import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const strictObject = { additionalProperties: false } as const;
const digestSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const resourceIdSchema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});

export const VNextGodotRunToolInputV1Schema = Type.Object({}, strictObject);
export type VNextGodotRunToolInputV1 = Static<
  typeof VNextGodotRunToolInputV1Schema
>;

const buildIdentitySchema = Type.Object(
  {
    buildId: resourceIdSchema,
    sourceClosureId: resourceIdSchema,
    candidateSourceHash: digestSchema,
  },
  strictObject,
);

const streamReceiptSchema = Type.Object(
  {
    totalBytes: Type.Integer({ minimum: 0 }),
    sha256: digestSchema,
    retainedBytes: Type.Integer({ minimum: 0, maximum: 64 * 1024 }),
    truncated: Type.Boolean(),
  },
  strictObject,
);

const processReceiptSchema = Type.Object(
  {
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    signal: Type.Union([
      Type.String({ minLength: 1, maxLength: 64 }),
      Type.Null(),
    ]),
    timedOut: Type.Boolean(),
    durationMs: Type.Integer({ minimum: 0, maximum: 600_000 }),
    stdout: streamReceiptSchema,
    stderr: streamReceiptSchema,
  },
  strictObject,
);

const executionReceiptSchema = Type.Object(
  {
    sandboxStatus: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("timed_out"),
      Type.Literal("cancelled"),
      Type.Literal("launch_failed"),
    ]),
    sandboxExitCode: Type.Union([Type.Integer(), Type.Null()]),
    sandboxSignal: Type.Union([
      Type.String({ minLength: 1, maxLength: 64 }),
      Type.Null(),
    ]),
    elapsedMonotonicMs: Type.Number({ minimum: 0, maximum: 600_000 }),
    sourceIdentityReverified: Type.Boolean(),
    import: Type.Union([processReceiptSchema, Type.Null()]),
    vanilla: Type.Union([processReceiptSchema, Type.Null()]),
  },
  strictObject,
);

const captureSchema = Type.Object(
  {
    stdout: Type.String({ maxLength: 64 * 1024 }),
    stderr: Type.String({ maxLength: 64 * 1024 }),
    stdoutTruncated: Type.Boolean(),
    stderrTruncated: Type.Boolean(),
  },
  strictObject,
);

export const VNextGodotRunSuccessV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    outcome: Type.Literal("success"),
    build: buildIdentitySchema,
    receipt: executionReceiptSchema,
    capture: captureSchema,
  },
  strictObject,
);

const errorSchema = Type.Object(
  {
    code: Type.Union([
      Type.Literal("prepare_failed"),
      Type.Literal("denied"),
      Type.Literal("execution_failed"),
    ]),
    message: Type.String({ minLength: 1, maxLength: 4_096 }),
    recoverable: Type.Boolean(),
  },
  strictObject,
);

export const VNextGodotRunErrorV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    outcome: Type.Literal("error"),
    error: errorSchema,
    build: Type.Optional(buildIdentitySchema),
    receipt: Type.Optional(executionReceiptSchema),
    capture: Type.Optional(captureSchema),
  },
  strictObject,
);

export const VNextGodotRunResultV1Schema = Type.Union([
  VNextGodotRunSuccessV1Schema,
  VNextGodotRunErrorV1Schema,
]);
export type VNextGodotRunResultV1 = Static<typeof VNextGodotRunResultV1Schema>;

export const VNextGodotRunToolCallV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    toolCallId: Type.String({ minLength: 1, maxLength: 256 }),
    result: VNextGodotRunResultV1Schema,
  },
  strictObject,
);
export type VNextGodotRunToolCallV1 = Static<
  typeof VNextGodotRunToolCallV1Schema
>;

export interface VNextGodotRunToolPortV1 {
  run(signal?: AbortSignal): Promise<unknown>;
}

export interface VNextGodotRunToolDefinitionOptionsV1 {
  readonly onCall?:
    ((call: VNextGodotRunToolCallV1) => void | Promise<void>) | undefined;
}

const responseContent = (value: VNextGodotRunResultV1) => [
  { type: "text" as const, text: JSON.stringify(value, null, 2) },
];

/**
 * Creates the neutral, shared Godot headless runner used by matched coding
 * Agent arms. The port owns workspace snapshotting and sandbox execution.
 */
export function createVNextGodotRunToolDefinitionV1(
  port: VNextGodotRunToolPortV1,
  options: VNextGodotRunToolDefinitionOptionsV1 = {},
): ToolDefinition {
  return defineTool({
    name: "godot_run",
    label: "godot_run",
    description:
      "Import the current workspace project and run its default scene with headless Godot in an isolated execution copy. Returns bounded raw process output and execution receipts.",
    promptSnippet: "Run the project with headless Godot",
    parameters: VNextGodotRunToolInputV1Schema,
    executionMode: "sequential",
    async execute(toolCallId, _input, signal) {
      const untrusted = await port.run(signal);
      if (!Check(VNextGodotRunResultV1Schema, untrusted)) {
        throw new TypeError("Invalid godot_run port result");
      }
      const call = {
        schemaVersion: 1,
        toolCallId,
        result: untrusted,
      } as const;
      if (!Check(VNextGodotRunToolCallV1Schema, call)) {
        throw new TypeError("Invalid godot_run call record");
      }
      await options.onCall?.(call);
      return { content: responseContent(untrusted), details: untrusted };
    },
  });
}
