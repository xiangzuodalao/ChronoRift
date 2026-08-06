import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";

import {
  INVESTIGATION_CAPABILITIES_V1,
  INVESTIGATION_TOOL_DEFINITIONS_V1,
  InvestigationCapabilityManifestV1Schema,
  ResourceHandleV1Schema,
  SourceReadInputV1Schema,
  isDiagnosisProposalDraftV1,
  parseInvestigationCapabilityManifestV1,
} from "../src/index.js";

const handle = (suffix: string): string => `rh_${suffix.padEnd(8, "0")}`;

const mechanismDraft = {
  schemaVersion: 1,
  capsuleHandle: handle("capsule"),
  baselineExecutionHandle: handle("baseline"),
  replayExecutionHandle: handle("replay"),
  candidateExecutionHandles: [handle("candidate")],
  comparisonHandles: [handle("comparison")],
  accessReceiptHandles: [handle("receipt")],
  claim: {
    kind: "mechanism",
    mechanismId: "signal.ordering.receiver_not_connected",
    assertion: {
      schemaId: "chronorift.claim.signal-ordering.v1",
      payload: { signal: "activated", receiver: "door" },
    },
  },
  summary: "The signal was emitted before the receiver connected.",
  evidenceEventHandles: [handle("event")],
  blockers: [],
  nextExperiment: null,
  confidence: 0.75,
} as const;

describe("ResourceHandleV1", () => {
  it("accepts opaque short handles and rejects paths or artifact IDs", () => {
    expect(Check(ResourceHandleV1Schema, handle("capsule"))).toBe(true);
    expect(Check(ResourceHandleV1Schema, "../capsule.json")).toBe(false);
    expect(Check(ResourceHandleV1Schema, "run-123")).toBe(false);
  });
});

describe("DiagnosisProposalDraftV1", () => {
  it("accepts an open mechanism and assertion payload", () => {
    expect(isDiagnosisProposalDraftV1(mechanismDraft)).toBe(true);
  });

  it("rejects a mechanism claim without replay, candidate, or comparison", () => {
    const withoutReplay: Record<string, unknown> = { ...mechanismDraft };
    delete withoutReplay.replayExecutionHandle;
    expect(isDiagnosisProposalDraftV1(withoutReplay)).toBe(false);
    expect(
      isDiagnosisProposalDraftV1({
        ...mechanismDraft,
        candidateExecutionHandles: [],
      }),
    ).toBe(false);
    expect(
      isDiagnosisProposalDraftV1({
        ...mechanismDraft,
        comparisonHandles: [],
      }),
    ).toBe(false);
  });

  it("rejects a non-JSON mechanism assertion payload", () => {
    expect(
      isDiagnosisProposalDraftV1({
        ...mechanismDraft,
        claim: {
          ...mechanismDraft.claim,
          assertion: {
            ...mechanismDraft.claim.assertion,
            payload: { invalid: undefined },
          },
        },
      }),
    ).toBe(false);
  });

  it("rejects unknown claims without a blocker and next experiment", () => {
    expect(
      isDiagnosisProposalDraftV1({
        ...mechanismDraft,
        claim: { kind: "unknown" },
        blockers: [],
        nextExperiment: null,
      }),
    ).toBe(false);
    expect(
      isDiagnosisProposalDraftV1({
        ...mechanismDraft,
        claim: { kind: "unknown" },
        blockers: ["No comparable intervention completed."],
        nextExperiment: "Replay once with event-loss accounting enabled.",
      }),
    ).toBe(true);
  });

  it("rejects duplicate handles and unknown fields", () => {
    expect(
      isDiagnosisProposalDraftV1({
        ...mechanismDraft,
        evidenceEventHandles: [handle("event"), handle("event")],
      }),
    ).toBe(false);
    expect(
      isDiagnosisProposalDraftV1({ ...mechanismDraft, runId: "run-1" }),
    ).toBe(false);
  });
});

describe("capability and tool contracts", () => {
  it("requires a strict, deduplicated capability manifest", () => {
    const manifest = {
      schemaVersion: 1,
      protocolVersion: "chronorift.investigation.v1",
      capabilities: [...INVESTIGATION_CAPABILITIES_V1],
      claimPolicies: [
        {
          policyId: "test.signal-ordering",
          policyVersion: "1.0.0",
          mechanismId: "signal_before_receiver_connection",
          assertionSchemaId: "chronorift.test.signal-ordering.v1",
          mechanismDescription:
            "A signal was emitted before its receiver was connected.",
          additionalProperties: false,
          assertionFields: [
            {
              name: "signalName",
              type: "string",
              required: true,
              description: "Observed signal name.",
            },
          ],
          evidenceRequirements: [
            "Cite the baseline emitted-signal event and failed-delivery event.",
            "Cite the candidate emitted-signal, successful-delivery, and expected property-change events.",
          ],
        },
      ],
      budgets: {
        maxToolCalls: 16,
        maxReplayCalls: 1,
        maxInterventions: 2,
        maxComparisons: 2,
        maxSourceReads: 4,
        maxSourceSearches: 4,
        maxSourceReadLines: 500,
        maxSourceSearchResults: 200,
      },
    };
    expect(Check(InvestigationCapabilityManifestV1Schema, manifest)).toBe(true);
    expect(
      Check(InvestigationCapabilityManifestV1Schema, {
        ...manifest,
        capabilities: ["capsule.read", "capsule.read"],
      }),
    ).toBe(false);
    expect(
      Check(InvestigationCapabilityManifestV1Schema, {
        ...manifest,
        unexpected: true,
      }),
    ).toBe(false);
    expect(parseInvestigationCapabilityManifestV1(manifest)).toEqual(manifest);
    expect(() =>
      parseInvestigationCapabilityManifestV1({
        ...manifest,
        claimPolicies: [
          ...manifest.claimPolicies,
          {
            ...manifest.claimPolicies[0],
            policyId: "test.zeta-policy",
          },
          {
            ...manifest.claimPolicies[0],
            policyId: "test.zeta-policy",
            mechanismId: "another_mechanism",
          },
        ],
      }),
    ).toThrow("claim policy catalog");
    expect(() =>
      parseInvestigationCapabilityManifestV1({
        ...manifest,
        claimPolicies: [
          {
            ...manifest.claimPolicies[0],
            assertionFields: [
              ...manifest.claimPolicies[0]!.assertionFields,
              ...manifest.claimPolicies[0]!.assertionFields,
            ],
          },
        ],
      }),
    ).toThrow("claim policy catalog");
  });

  it("publishes one centrally-defined input schema per capability", () => {
    expect(INVESTIGATION_TOOL_DEFINITIONS_V1).toHaveLength(
      INVESTIGATION_CAPABILITIES_V1.length,
    );
    expect(
      new Set(INVESTIGATION_TOOL_DEFINITIONS_V1.map((tool) => tool.name)).size,
    ).toBe(INVESTIGATION_TOOL_DEFINITIONS_V1.length);
    expect(
      new Set(INVESTIGATION_TOOL_DEFINITIONS_V1.map((tool) => tool.capability)),
    ).toEqual(new Set(INVESTIGATION_CAPABILITIES_V1));
  });

  it("publishes the safe catalog and strict replay prerequisites", () => {
    const byName = new Map(
      INVESTIGATION_TOOL_DEFINITIONS_V1.map((tool) => [tool.name, tool]),
    );
    expect(byName.get("game_list_interventions_v4")?.description).toContain(
      "may be read before or after replay",
    );
    expect(byName.get("game_run_intervention_v4")?.description).toContain(
      "after one successful strict replay",
    );
  });

  it("keeps tool input schemas strict", () => {
    expect(
      Check(SourceReadInputV1Schema, { path: "case/main.gd", extra: true }),
    ).toBe(false);
  });
});
