import { describe, expect, it } from "vitest";

import {
  asCapsuleId,
  asComparisonId,
  asExecutionId,
  asProposalId,
  asRunId,
  asVerdictId,
  type DiagnosisProposal,
  type DiagnosisVerdict,
} from "@chronorift/domain";
import type { PiDiagnosisRunResult } from "@chronorift/pi-harness";

import { createPiSmokeSummary } from "./pi-smoke.js";

const proposal: DiagnosisProposal = {
  schemaVersion: 1,
  proposalId: asProposalId("proposal:smoke"),
  runId: asRunId("run:smoke"),
  capsuleId: asCapsuleId("capsule:smoke"),
  baselineExecutionId: asExecutionId("execution:baseline"),
  replayExecutionId: asExecutionId("execution:replay"),
  candidateExecutionId: asExecutionId("execution:candidate"),
  comparisonId: asComparisonId("comparison:smoke"),
  claim: { kind: "unknown", summary: "Smoke diagnosis" },
  observedFacts: [],
  hypotheses: ["Receiver timing"],
  unknowns: ["Needs experiment"],
  attemptedActions: [],
  blockers: ["Smoke fixture"],
  nextExperiment: "Replay the baseline",
  confidence: 0.5,
};

const verdict: DiagnosisVerdict = {
  schemaVersion: 1,
  verdictId: asVerdictId("verdict:smoke"),
  runId: proposal.runId,
  proposalId: proposal.proposalId,
  status: "confirmed",
  claimLevel: "mechanism_supported",
  mechanismCode: "signal_before_receiver_connection",
  summary: "Confirmed",
  validatedReferences: [],
  blockers: [],
  nextExperiment: null,
};

const inconclusiveVerdict: DiagnosisVerdict = {
  schemaVersion: 1,
  verdictId: asVerdictId("verdict:inconclusive"),
  proposalId: proposal.proposalId,
  runId: proposal.runId,
  status: "inconclusive",
  claimLevel: "none",
  summary: "Inconclusive",
  validatedReferences: [],
  blockers: [
    {
      code: "CLAIM_NOT_SUPPORTED",
      message: "Missing evidence",
      references: [],
    },
  ],
  nextExperiment: "Run a replay",
};

const result = (tokens: number, toolCalls = 5): PiDiagnosisRunResult => ({
  proposal,
  piSession: {
    sessionId: "session:smoke",
    sessionFile: "/temporary/pi-session.jsonl",
    provider: "volcengine-coding-plan",
    model: "glm-5.2",
    thinkingLevel: "medium",
    stats: {
      toolCalls,
      tokens: {
        input: tokens,
        output: tokens,
        cacheRead: 0,
        cacheWrite: 0,
        total: tokens * 2,
      },
      cost: 0,
    },
  },
});

describe("Pi provider smoke summary", () => {
  it("publishes only sanitized proof of a real Agent flow", () => {
    const summary = createPiSmokeSummary(
      result(10),
      { proposal, verdict },
      true,
    );
    expect(summary).toMatchObject({
      ok: true,
      sessionPersisted: true,
      verdict: "confirmed",
      toolCalls: 5,
      tokens: { total: 20 },
    });
    expect(JSON.stringify(summary)).not.toContain("sessionFile");
  });

  it("rejects zero-token, zero-tool, missing-Session, and unconfirmed runs", () => {
    expect(() =>
      createPiSmokeSummary(result(0), { proposal, verdict }, true),
    ).toThrow("non-zero model tokens");
    expect(() =>
      createPiSmokeSummary(result(10, 0), { proposal, verdict }, true),
    ).toThrow("Agent tool call");
    expect(() =>
      createPiSmokeSummary(result(10), { proposal, verdict }, false),
    ).toThrow("persist");
    expect(() =>
      createPiSmokeSummary(
        result(10),
        {
          proposal,
          verdict: inconclusiveVerdict,
        },
        true,
      ),
    ).toThrow("inconclusive");
  });
});
