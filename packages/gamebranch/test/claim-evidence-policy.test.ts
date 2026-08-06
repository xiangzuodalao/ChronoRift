import type { JsonObject } from "@chronorift/domain";
import { describe, expect, it } from "vitest";

import {
  ClaimEvidencePolicyRegistry,
  v04ClaimPolicyManifestFor,
  type ClaimAssertionSchema,
  type ClaimEvidenceContext,
  type ClaimEvidencePolicy,
} from "../src/index.js";

interface MarkerAssertion {
  readonly marker: string;
}

const markerSchema: ClaimAssertionSchema<MarkerAssertion> = {
  safeParse: (payload) => {
    const keys = Object.keys(payload);
    if (
      keys.length !== 1 ||
      keys[0] !== "marker" ||
      typeof payload["marker"] !== "string" ||
      payload["marker"].length === 0
    ) {
      return {
        success: false,
        issues: [{ path: [], message: "Expected only a non-empty marker" }],
      };
    }
    return { success: true, data: { marker: payload["marker"] } };
  },
};

const markerPolicy = (
  policyId = "test.marker-policy",
  mechanismId = "animation_marker_skipped",
): ClaimEvidencePolicy<MarkerAssertion> => ({
  descriptor: {
    policyId,
    policyVersion: "1.0.0",
    mechanismId,
    assertionSchemaId: "chronorift.test.marker-assertion.v1",
  },
  agentContract: {
    mechanismDescription:
      "An animation marker required by gameplay logic was skipped.",
    evidenceRequirements: [
      "Cite the baseline event that reaches the required animation marker.",
      "Cite the candidate event that skips the required animation marker.",
    ],
    additionalProperties: false,
    assertionFields: [
      {
        name: "marker",
        type: "string",
        required: true,
        description: "Exact marker name supported by the cited evidence.",
      },
    ],
  },
  assertionSchema: markerSchema,
  evaluate: ({ assertion }) =>
    assertion.marker === "damage"
      ? { supported: true, blockers: [] }
      : {
          supported: false,
          blockers: [
            {
              code: "evidence_missing",
              message: `No evidence supports marker ${assertion.marker}`,
            },
          ],
        },
});

const unusedContext = {} as ClaimEvidenceContext;

const evaluate = (registry: ClaimEvidencePolicyRegistry, payload: JsonObject) =>
  registry.evaluate({
    mechanismId: "animation_marker_skipped",
    assertion: {
      schemaId: "chronorift.test.marker-assertion.v1",
      payload,
    },
    context: unusedContext,
  });

describe("ClaimEvidencePolicyRegistry", () => {
  it("derives a registration-order-independent manifest whose hash binds versions", () => {
    const first = markerPolicy().descriptor;
    const second = markerPolicy(
      "test.zeta-policy",
      "zeta_mechanism",
    ).descriptor;
    const forward = v04ClaimPolicyManifestFor([first, second]);
    const reverse = v04ClaimPolicyManifestFor([second, first]);
    const changedVersion = v04ClaimPolicyManifestFor([
      { ...first, policyVersion: "1.0.1" },
      second,
    ]);

    expect(forward).toEqual(reverse);
    expect(forward.policies.map((entry) => entry.policyId)).toEqual([
      "test.marker-policy",
      "test.zeta-policy",
    ]);
    expect(changedVersion.manifestHash).not.toBe(forward.manifestHash);
  });

  it("registers a new mechanism without a central mechanism enum", () => {
    const registry = new ClaimEvidencePolicyRegistry().register(markerPolicy());

    expect(evaluate(registry, { marker: "damage" })).toEqual({
      supported: true,
      blockers: [],
    });
    expect(registry.descriptors()).toHaveLength(1);
  });

  it("publishes sorted, immutable Agent contracts without assertion values", () => {
    const registry = new ClaimEvidencePolicyRegistry()
      .register(markerPolicy("test.zeta-policy", "zeta_mechanism"))
      .register(markerPolicy());

    const descriptors = registry.agentDescriptors();
    expect(descriptors.map((descriptor) => descriptor.policyId)).toEqual([
      "test.marker-policy",
      "test.zeta-policy",
    ]);
    expect(descriptors[0]).toEqual({
      ...markerPolicy().descriptor,
      mechanismDescription:
        "An animation marker required by gameplay logic was skipped.",
      evidenceRequirements: [
        "Cite the baseline event that reaches the required animation marker.",
        "Cite the candidate event that skips the required animation marker.",
      ],
      additionalProperties: false,
      assertionFields: [
        {
          name: "marker",
          type: "string",
          required: true,
          description: "Exact marker name supported by the cited evidence.",
        },
      ],
    });
    expect(Object.isFrozen(descriptors)).toBe(true);
    expect(Object.isFrozen(descriptors[0])).toBe(true);
    expect(Object.isFrozen(descriptors[0]!.evidenceRequirements)).toBe(true);
    expect(Object.isFrozen(descriptors[0]!.assertionFields)).toBe(true);
    expect(descriptors[0]).not.toHaveProperty("assertion");
  });

  it("rejects ambiguous or contradictory Agent field contracts", () => {
    const emptyRequirements = markerPolicy();
    expect(() =>
      new ClaimEvidencePolicyRegistry().register({
        ...emptyRequirements,
        agentContract: {
          ...emptyRequirements.agentContract,
          evidenceRequirements: [],
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_AGENT_CONTRACT" }) as Error,
    );

    const duplicateRequirements = markerPolicy();
    expect(() =>
      new ClaimEvidencePolicyRegistry().register({
        ...duplicateRequirements,
        agentContract: {
          ...duplicateRequirements.agentContract,
          evidenceRequirements: [
            duplicateRequirements.agentContract.evidenceRequirements[0]!,
            duplicateRequirements.agentContract.evidenceRequirements[0]!,
          ],
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_AGENT_CONTRACT" }) as Error,
    );

    const blankRequirement = markerPolicy();
    expect(() =>
      new ClaimEvidencePolicyRegistry().register({
        ...blankRequirement,
        agentContract: {
          ...blankRequirement.agentContract,
          evidenceRequirements: [" "],
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_AGENT_CONTRACT" }) as Error,
    );

    const emptyFields = markerPolicy();
    expect(() =>
      new ClaimEvidencePolicyRegistry().register({
        ...emptyFields,
        agentContract: {
          ...emptyFields.agentContract,
          assertionFields: [],
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_AGENT_CONTRACT" }) as Error,
    );

    const duplicateFields = markerPolicy();
    expect(() =>
      new ClaimEvidencePolicyRegistry().register({
        ...duplicateFields,
        agentContract: {
          ...duplicateFields.agentContract,
          assertionFields: [
            ...duplicateFields.agentContract.assertionFields,
            ...duplicateFields.agentContract.assertionFields,
          ],
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_AGENT_CONTRACT" }) as Error,
    );

    const wrongEnumType = markerPolicy();
    expect(() =>
      new ClaimEvidencePolicyRegistry().register({
        ...wrongEnumType,
        agentContract: {
          ...wrongEnumType.agentContract,
          assertionFields: [
            {
              ...wrongEnumType.agentContract.assertionFields[0]!,
              allowedValues: [1],
            },
          ],
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_AGENT_CONTRACT" }) as Error,
    );

    const invalidMinimum = markerPolicy();
    expect(() =>
      new ClaimEvidencePolicyRegistry().register({
        ...invalidMinimum,
        agentContract: {
          ...invalidMinimum.agentContract,
          assertionFields: [
            {
              ...invalidMinimum.agentContract.assertionFields[0]!,
              minimum: 0,
            },
          ],
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_AGENT_CONTRACT" }) as Error,
    );
  });

  it("strictly rejects unknown assertion fields and schema IDs", () => {
    const registry = new ClaimEvidencePolicyRegistry().register(markerPolicy());

    expect(() =>
      evaluate(registry, { marker: "damage", injected: true }),
    ).toThrowError(
      expect.objectContaining({ code: "ASSERTION_INVALID" }) as Error,
    );
    expect(() =>
      registry.evaluate({
        mechanismId: "animation_marker_skipped",
        assertion: { schemaId: "wrong.schema", payload: { marker: "damage" } },
        context: unusedContext,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "ASSERTION_SCHEMA_MISMATCH" }) as Error,
    );
  });

  it("rejects unknown mechanisms and registration collisions", () => {
    const registry = new ClaimEvidencePolicyRegistry().register(markerPolicy());

    expect(() => registry.register(markerPolicy())).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_POLICY_ID" }) as Error,
    );
    expect(() =>
      registry.register(markerPolicy("test.second-policy")),
    ).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_MECHANISM_ID" }) as Error,
    );
    expect(() =>
      registry.evaluate({
        mechanismId: "unregistered_mechanism",
        assertion: {
          schemaId: "chronorift.test.marker-assertion.v1",
          payload: { marker: "damage" },
        },
        context: unusedContext,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "UNKNOWN_MECHANISM_ID" }) as Error,
    );
  });
});
