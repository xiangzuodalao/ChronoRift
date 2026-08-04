import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { RestrictedSourceAccess } from "../types.js";
import type { HarnessToolFlow } from "./tool-flow.js";

const strictObject = { additionalProperties: false } as const;
const IdSchema = Type.String({ minLength: 1 });
const JsonObjectInputSchema = Type.Record(Type.String(), Type.Unknown());
const OutcomeSchema = Type.Union([
  Type.Literal("pass"),
  Type.Literal("fail"),
  Type.Literal("incomplete"),
  Type.Literal("mixed"),
]);

const DiagnosisExperimentSchema = Type.Object(
  {
    branchId: IdSchema,
    outcome: OutcomeSchema,
    evidenceIds: Type.Array(IdSchema),
    observation: Type.String({ minLength: 1 }),
  },
  strictObject,
);

const DiagnosisComparisonSchema = Type.Object(
  {
    baselineBranchId: IdSchema,
    candidateBranchId: IdSchema,
    finding: Type.String({ minLength: 1 }),
  },
  strictObject,
);

export const DiagnosisReportToolSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    conclusion: Type.String({ minLength: 1 }),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    evidenceIds: Type.Array(IdSchema, { minItems: 1 }),
    experiments: Type.Array(DiagnosisExperimentSchema, { minItems: 1 }),
    comparisons: Type.Array(DiagnosisComparisonSchema, { minItems: 1 }),
    suggestedFix: Type.String({ minLength: 1 }),
  },
  strictObject,
);

export const PI_TOOL_NAMES = [
  "game_get_evidence",
  "game_fork_timeline",
  "game_replay_timeline",
  "game_compare_timelines",
  "source_read",
  "source_search",
  "submit_diagnosis",
] as const;

function abortIfRequested(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function jsonContent(value: unknown): [{ type: "text"; text: string }] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

export function createPiTools(
  flow: HarnessToolFlow,
  source: RestrictedSourceAccess,
): ToolDefinition[] {
  const getEvidence = defineTool({
    name: "game_get_evidence",
    label: "Get game evidence",
    description:
      "Read compiled state differences, causal events, and anomaly evidence by evidence ID.",
    promptSnippet: "Read a compiled game anomaly evidence record",
    parameters: Type.Object({ evidenceId: IdSchema }, strictObject),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      abortIfRequested(signal);
      const evidence = await flow.getEvidence(params.evidenceId);
      abortIfRequested(signal);
      return {
        content: jsonContent(evidence),
        details: evidence,
      };
    },
  });

  const forkTimeline = defineTool({
    name: "game_fork_timeline",
    label: "Fork game timeline",
    description:
      "Create an experimental branch from a checkpoint returned by evidence or replay. Controls must change only the variable under test.",
    promptSnippet: "Fork an experiment from an observed game checkpoint",
    parameters: Type.Object(
      {
        checkpointId: IdSchema,
        controls: JsonObjectInputSchema,
        label: Type.Optional(Type.String({ minLength: 1 })),
      },
      strictObject,
    ),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      abortIfRequested(signal);
      const branch = await flow.forkTimeline(params);
      abortIfRequested(signal);
      return {
        content: jsonContent(branch),
        details: branch,
      };
    },
  });

  const replayTimeline = defineTool({
    name: "game_replay_timeline",
    label: "Replay game timeline",
    description:
      "Replay a baseline or experimental branch and return its evaluated outcome and evidence IDs.",
    promptSnippet: "Replay and evaluate a known game branch",
    parameters: Type.Object({ branchId: IdSchema }, strictObject),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      abortIfRequested(signal);
      const replay = await flow.replayTimeline(params);
      abortIfRequested(signal);
      return {
        content: jsonContent(replay),
        details: replay,
      };
    },
  });

  const compareTimelines = defineTool({
    name: "game_compare_timelines",
    label: "Compare game timelines",
    description:
      "Compare two branches after both were replayed, including their outcomes and first divergence.",
    promptSnippet: "Compare two replayed game branches",
    parameters: Type.Object(
      {
        baselineBranchId: IdSchema,
        candidateBranchId: IdSchema,
      },
      strictObject,
    ),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      abortIfRequested(signal);
      const comparison = await flow.compareTimelines(params);
      abortIfRequested(signal);
      return {
        content: jsonContent(comparison),
        details: comparison,
      };
    },
  });

  const sourceRead = defineTool({
    name: "source_read",
    label: "Read source",
    description:
      "Read a UTF-8 source file under the configured repository root. Absolute paths and paths escaping the root are rejected.",
    promptSnippet: "Read a repository-confined source file",
    parameters: Type.Object(
      {
        path: Type.String({ minLength: 1 }),
        offset: Type.Optional(Type.Integer({ minimum: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
      },
      strictObject,
    ),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      abortIfRequested(signal);
      const result = await source.read(params);
      abortIfRequested(signal);
      return {
        content: jsonContent(result),
        details: result,
      };
    },
  });

  const sourceSearch = defineTool({
    name: "source_search",
    label: "Search source",
    description:
      "Search literal text in UTF-8 files under the configured repository root without invoking a shell.",
    promptSnippet: "Search repository-confined source text",
    parameters: Type.Object(
      {
        query: Type.String({ minLength: 1, maxLength: 500 }),
        path: Type.Optional(Type.String({ minLength: 1 })),
        includeSuffixes: Type.Optional(
          Type.Array(Type.String({ minLength: 2, maxLength: 32 }), {
            minItems: 1,
          }),
        ),
        caseSensitive: Type.Optional(Type.Boolean()),
        maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      },
      strictObject,
    ),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      abortIfRequested(signal);
      const result = await source.search(params);
      abortIfRequested(signal);
      return {
        content: jsonContent(result),
        details: result,
      };
    },
  });

  const submitDiagnosis = defineTool({
    name: "submit_diagnosis",
    label: "Submit diagnosis",
    description:
      "Validate and submit the canonical diagnosis. Call this alone in the final tool batch after experiments and comparison.",
    promptSnippet: "Submit the final evidence-backed diagnosis",
    parameters: DiagnosisReportToolSchema,
    executionMode: "sequential",
    execute: (_toolCallId, params, signal) => {
      abortIfRequested(signal);
      const report = flow.submitDiagnosis(params);
      return Promise.resolve({
        content: [{ type: "text", text: "Diagnosis accepted." }],
        details: { accepted: true, report },
        terminate: true,
      });
    },
  });

  return [
    getEvidence,
    forkTimeline,
    replayTimeline,
    compareTimelines,
    sourceRead,
    sourceSearch,
    submitDiagnosis,
  ];
}
