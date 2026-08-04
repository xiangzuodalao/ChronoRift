import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { HarnessToolFlow } from "./tool-flow.js";

const strictObject = { additionalProperties: false } as const;
const IdSchema = Type.String({ minLength: 1 });

const ArtifactReferenceToolSchema = Type.Union([
  Type.Object(
    { artifactKind: Type.Literal("contract"), contractId: IdSchema },
    strictObject,
  ),
  Type.Object(
    { artifactKind: Type.Literal("branch"), branchId: IdSchema },
    strictObject,
  ),
  Type.Object(
    { artifactKind: Type.Literal("checkpoint"), checkpointId: IdSchema },
    strictObject,
  ),
  Type.Object(
    { artifactKind: Type.Literal("execution"), executionId: IdSchema },
    strictObject,
  ),
  Type.Object(
    { artifactKind: Type.Literal("capsule"), capsuleId: IdSchema },
    strictObject,
  ),
  Type.Object(
    { artifactKind: Type.Literal("comparison"), comparisonId: IdSchema },
    strictObject,
  ),
  Type.Object(
    { artifactKind: Type.Literal("event"), eventId: IdSchema },
    strictObject,
  ),
]);

const ObservedFactToolSchema = Type.Object(
  {
    statement: Type.String({ minLength: 1 }),
    references: Type.Array(ArtifactReferenceToolSchema, { minItems: 1 }),
  },
  strictObject,
);

const ClaimToolSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("mechanism"),
      summary: Type.String({ minLength: 1 }),
      mechanism: Type.String({ minLength: 1 }),
      category: Type.Union([
        Type.Literal("signal_ordering"),
        Type.Literal("state"),
        Type.Literal("input"),
        Type.Literal("unknown"),
      ]),
      mechanismCode: Type.Union([
        Type.Literal("signal_before_receiver_connection"),
        Type.Literal("signal_rejected_by_connected_receiver"),
        Type.Literal("input_not_applied"),
      ]),
      assertion: Type.Object(
        {
          signal: Type.Object(
            {
              kind: Type.Literal("signal"),
              source: Type.String({ minLength: 1 }),
              name: Type.String({ minLength: 1 }),
            },
            strictObject,
          ),
          receiver: Type.String({ minLength: 1 }),
          failedDeliveryReason: Type.Union([
            Type.Literal("receiver_not_connected"),
            Type.Literal("receiver_rejected"),
            Type.Literal("unknown"),
          ]),
          expectedEffect: Type.Object(
            {
              kind: Type.Literal("property_equals"),
              path: Type.String({ minLength: 1 }),
              value: Type.Unknown(),
            },
            strictObject,
          ),
          intervention: Type.Object(
            {
              kind: Type.Literal("delay_input"),
              deltaTicks: Type.Literal(1),
            },
            strictObject,
          ),
        },
        strictObject,
      ),
    },
    strictObject,
  ),
  Type.Object(
    {
      kind: Type.Literal("unknown"),
      summary: Type.String({ minLength: 1 }),
    },
    strictObject,
  ),
]);

export const DiagnosisProposalToolSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    proposalId: IdSchema,
    runId: IdSchema,
    capsuleId: IdSchema,
    baselineExecutionId: IdSchema,
    replayExecutionId: Type.Optional(IdSchema),
    candidateExecutionId: Type.Optional(IdSchema),
    comparisonId: Type.Optional(IdSchema),
    claim: ClaimToolSchema,
    observedFacts: Type.Array(ObservedFactToolSchema, { minItems: 1 }),
    hypotheses: Type.Array(Type.String({ minLength: 1 })),
    unknowns: Type.Array(Type.String({ minLength: 1 })),
    attemptedActions: Type.Array(Type.String({ minLength: 1 })),
    blockers: Type.Array(Type.String({ minLength: 1 })),
    nextExperiment: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
  },
  strictObject,
);

export const PI_TOOL_NAMES = [
  "game_get_evidence_capsule",
  "game_replay_execution",
  "game_run_intervention",
  "game_compare_executions",
  "submit_diagnosis_proposal",
] as const;

function abortIfRequested(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function jsonContent(value: unknown): [{ type: "text"; text: string }] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

export function createPiTools(flow: HarnessToolFlow): ToolDefinition[] {
  const getEvidenceCapsule = defineTool({
    name: "game_get_evidence_capsule",
    label: "Get Evidence Capsule",
    description:
      "Read the immutable v0.1 switch-door Evidence Capsule. The capsule identifies the only admissible baseline execution.",
    promptSnippet: "Read the frozen game-runtime evidence capsule",
    parameters: Type.Object({ capsuleId: IdSchema }, strictObject),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      abortIfRequested(signal);
      const capsule = await flow.getEvidenceCapsule(params.capsuleId);
      abortIfRequested(signal);
      return { content: jsonContent(capsule), details: capsule };
    },
  });

  const replayExecution = defineTool({
    name: "game_replay_execution",
    label: "Replay baseline execution",
    description:
      "Restore and replay the baseline Execution named by the capsule. v0.1 permits one replay and returns a new sealed ExecutionLog plus digest match receipt.",
    promptSnippet: "Replay the capsule baseline from its checkpoint",
    parameters: Type.Object({ executionId: IdSchema }, strictObject),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      abortIfRequested(signal);
      const replay = await flow.replayExecution(params);
      abortIfRequested(signal);
      return { content: jsonContent(replay), details: replay };
    },
  });

  const runIntervention = defineTool({
    name: "game_run_intervention",
    label: "Run one-tick intervention",
    description:
      "Create and execute the sole v0.1 intervention: delay the fixture's only switch interaction by exactly one tick. The Harness verifies the realized single-variable change.",
    promptSnippet: "Run the one-tick switch-input intervention",
    parameters: Type.Object(
      {
        baselineExecutionId: IdSchema,
        deltaTicks: Type.Literal(1),
      },
      strictObject,
    ),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      abortIfRequested(signal);
      const result = await flow.runIntervention(params);
      abortIfRequested(signal);
      return { content: jsonContent(result), details: result };
    },
  });

  const compareExecutions = defineTool({
    name: "game_compare_executions",
    label: "Compare executions",
    description:
      "Compare the returned baseline replay and one-tick intervention executions using the Harness comparator.",
    promptSnippet: "Compare the replay and intervention executions",
    parameters: Type.Object(
      {
        baselineExecutionId: IdSchema,
        candidateExecutionId: IdSchema,
      },
      strictObject,
    ),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      abortIfRequested(signal);
      const comparison = await flow.compareExecutions(params);
      abortIfRequested(signal);
      return { content: jsonContent(comparison), details: comparison };
    },
  });

  const submitProposal = defineTool({
    name: "submit_diagnosis_proposal",
    label: "Submit diagnosis proposal",
    description:
      "Submit the Agent's evidence-linked proposal, never a canonical verdict. A mechanism claim requires this session's replay, intervention, and comparison. An unknown claim may abstain with blockers and a next experiment.",
    promptSnippet: "Submit an evidence-linked diagnosis proposal",
    parameters: DiagnosisProposalToolSchema,
    executionMode: "sequential",
    execute: (_toolCallId, params, signal) => {
      abortIfRequested(signal);
      const proposal = flow.submitDiagnosisProposal(params);
      return Promise.resolve({
        content: [{ type: "text", text: "Diagnosis proposal accepted." }],
        details: { accepted: true, proposal },
        terminate: true,
      });
    },
  });

  return [
    getEvidenceCapsule,
    replayExecution,
    runIntervention,
    compareExecutions,
    submitProposal,
  ];
}
