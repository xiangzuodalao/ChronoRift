import {
  DiagnosisProposalV2Schema,
  DiagnosisProposalV3Schema,
  EvidenceAccessReceiptV1Schema,
  FailureBriefV1Schema,
  RuntimeCapabilitySchema,
  V03TelemetryEventSchema,
  asCapsuleId,
  asContractId,
  asEventId,
  asEvidenceAccessReceiptId,
  asExecutionId,
  asFixtureId,
  asProposalId,
  asRunId,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const ids = {
  runId: asRunId("run:test"),
  fixtureId: asFixtureId("fixture:opaque"),
  contractId: asContractId("contract:test"),
  capsuleId: asCapsuleId("capsule:test"),
  baselineExecutionId: asExecutionId("execution:baseline"),
};

describe("v0.3 diagnostic V3 contracts", () => {
  it("validates the arm-neutral Failure Brief strictly", () => {
    const brief = {
      schemaVersion: 1 as const,
      ...ids,
      trigger: { kind: "signal" as const, source: "switch", name: "activated" },
      triggerEventId: asEventId("event:trigger"),
      triggerTick: 1,
      expectation: {
        kind: "property_equals" as const,
        path: "door.open",
        value: true,
      },
      deadlineTick: 2,
      actual: { present: true as const, value: false },
      violationSummary: "The frozen expectation was not satisfied.",
    };
    expect(FailureBriefV1Schema.parse(brief)).toEqual(brief);
    expect(() =>
      FailureBriefV1Schema.parse({ ...brief, arm: "chronorift-full" }),
    ).toThrow();
    expect(() =>
      FailureBriefV1Schema.parse({ ...brief, deadlineTick: 0 }),
    ).toThrow();
  });

  it("allows truthful empty search coverage and forbids it on non-source receipts", () => {
    const receipt = {
      schemaVersion: 1 as const,
      receiptId: asEvidenceAccessReceiptId("receipt:source"),
      runId: ids.runId,
      fixtureId: ids.fixtureId,
      accessKind: "source_read" as const,
      resourceId: "case/main.gd",
      requestHash: "a".repeat(64),
      contentHash: "b".repeat(64),
      sourceCoverage: [
        {
          virtualPath: "case/main.gd",
          startLine: 1,
          endLine: 20,
          coveredSymbols: ["_resolve_pending_effects"],
        },
      ],
      issuedAt: "2026-08-05T00:00:00.000Z",
    };
    expect(EvidenceAccessReceiptV1Schema.parse(receipt)).toEqual(receipt);
    expect(
      EvidenceAccessReceiptV1Schema.parse({
        ...receipt,
        accessKind: "source_search",
        sourceCoverage: [],
      }).sourceCoverage,
    ).toEqual([]);
    expect(() =>
      EvidenceAccessReceiptV1Schema.parse({
        ...receipt,
        accessKind: "capsule",
      }),
    ).toThrow();
    expect(() =>
      EvidenceAccessReceiptV1Schema.parse({
        ...receipt,
        sourceCoverage: [{ ...receipt.sourceCoverage[0]!, endLine: 0 }],
      }),
    ).toThrow();
  });

  it("preserves the V2 reader and validates unique V3 references", () => {
    const common = {
      proposalId: asProposalId("proposal:test"),
      runId: ids.runId,
      fixtureId: ids.fixtureId,
      capsuleId: ids.capsuleId,
      baselineExecutionId: ids.baselineExecutionId,
      comparisonIds: [],
      mechanismCode: "unknown" as const,
      summary: "Evidence remains insufficient.",
      evidenceEventIds: [],
      blockers: ["No causal intervention"],
      nextExperiment: "Run one controlled intervention.",
      confidence: 1,
    };
    expect(
      DiagnosisProposalV2Schema.parse({
        schemaVersion: 2,
        ...common,
      }).schemaVersion,
    ).toBe(2);

    const proposal = {
      schemaVersion: 3 as const,
      ...common,
      candidateExecutionIds: [asExecutionId("execution:candidate")],
      accessReceiptIds: [asEvidenceAccessReceiptId("receipt:test")],
    };
    expect(DiagnosisProposalV3Schema.parse(proposal).confidence).toBe(1);
    expect(() =>
      DiagnosisProposalV3Schema.parse({
        ...proposal,
        accessReceiptIds: [
          asEvidenceAccessReceiptId("receipt:test"),
          asEvidenceAccessReceiptId("receipt:test"),
        ],
      }),
    ).toThrow();
  });

  it("accepts pending-effect telemetry and negotiates its capability", () => {
    const pending = {
      schemaVersion: 2 as const,
      eventId: asEventId("event:pending"),
      executionId: ids.baselineExecutionId,
      runId: ids.runId,
      branchId: "branch:test",
      seq: 0,
      tick: 0,
      simTimeUs: 0,
      kind: "pending_effect" as const,
      action: "scheduled" as const,
      effectId: "effect:1",
      target: { stableId: "enemy", incarnation: 1 },
      dueTick: 1,
    };
    expect(V03TelemetryEventSchema.parse(pending).kind).toBe("pending_effect");
    expect(RuntimeCapabilitySchema.parse("observe.pending_effect")).toBe(
      "observe.pending_effect",
    );
    expect(() =>
      V03TelemetryEventSchema.parse({
        ...pending,
        reason: "invented_reason",
      }),
    ).toThrow();
  });
});
