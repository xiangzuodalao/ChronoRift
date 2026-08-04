import { describe, expect, it } from "vitest";

import {
  DiagnosisReportSchema,
  TemporalInvariantSchema,
  asBranchId,
  asEvaluationId,
  asEvidenceId,
  asInvariantId,
  asReportId,
  asRunId,
} from "../src/index.js";

describe("domain runtime schemas", () => {
  it("rejects unknown invariant fields and ambiguous negative tick windows", () => {
    const invariant = {
      schemaVersion: 1,
      invariantId: asInvariantId("door-opens"),
      description: "door opens",
      severity: "error",
      trigger: { kind: "signal", source: "/switch", name: "activated" },
      expectation: {
        kind: "property_equals",
        path: "/door/open",
        value: true,
      },
      withinTicks: 2,
      inclusive: true,
    } as const;

    expect(TemporalInvariantSchema.parse(invariant)).toEqual(invariant);
    expect(() =>
      TemporalInvariantSchema.parse({ ...invariant, withinTicks: -1 }),
    ).toThrow();
    expect(() =>
      TemporalInvariantSchema.parse({ ...invariant, executableRule: "code" }),
    ).toThrow();
  });

  it("requires structured diagnosis evidence and bounded confidence", () => {
    const report = {
      schemaVersion: 1,
      reportId: asReportId("report-1"),
      runId: asRunId("run-1"),
      status: "confirmed",
      conclusion: {
        summary: "Exact time comparison misses the deadline",
        mechanism: "The simulated clock steps over the equality target",
        category: "timing",
        suspectedLocations: [{ path: "mock-door.ts", symbol: "step" }],
      },
      confidence: 0.95,
      evidenceIds: [asEvidenceId("evidence-1")],
      branchComparisons: [
        {
          baselineBranchId: asBranchId("branch-1"),
          experimentalBranchId: asBranchId("branch-2"),
          changedControls: [{ name: "deltaUs", before: 16_667, after: 16_000 }],
          baselineEvaluationId: asEvaluationId("evaluation-1"),
          experimentalEvaluationId: asEvaluationId("evaluation-2"),
          observation: "The experiment opens the door",
          interpretation: "The defect is frame-step-sensitive",
        },
      ],
      suggestedFix: {
        summary: "Use an elapsed-time threshold",
        targets: [{ path: "mock-door.ts", symbol: "step" }],
        strategy: "Replace equality with >= and clear the pending timer",
        validationSteps: ["Replay at both frame durations"],
      },
      limitations: [],
    } as const;

    expect(DiagnosisReportSchema.parse(report).confidence).toBe(0.95);
    expect(() =>
      DiagnosisReportSchema.parse({ ...report, confidence: 1.01 }),
    ).toThrow();
    expect(() =>
      DiagnosisReportSchema.parse({ ...report, evidenceIds: [] }),
    ).toThrow();
  });
});
