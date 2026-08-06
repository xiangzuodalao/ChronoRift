import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const strictObject = { additionalProperties: false } as const;

export const INVESTIGATION_CAPABILITIES_V1 = [
  "capsule.read",
  "execution.replay",
  "intervention.list",
  "intervention.run",
  "execution.compare",
  "source.read",
  "source.search",
  "proposal.submit",
] as const;

export type InvestigationCapabilityV1 =
  (typeof INVESTIGATION_CAPABILITIES_V1)[number];

export const InvestigationCapabilityV1Schema = Type.Union(
  INVESTIGATION_CAPABILITIES_V1.map((capability) => Type.Literal(capability)),
);

export const InvestigationBudgetsV1Schema = Type.Object(
  {
    maxToolCalls: Type.Integer({ minimum: 1 }),
    maxReplayCalls: Type.Integer({ minimum: 0 }),
    maxInterventions: Type.Integer({ minimum: 0 }),
    maxComparisons: Type.Integer({ minimum: 0 }),
    maxSourceReads: Type.Integer({ minimum: 0 }),
    maxSourceSearches: Type.Integer({ minimum: 0 }),
    maxSourceReadLines: Type.Integer({ minimum: 1 }),
    maxSourceSearchResults: Type.Integer({ minimum: 1 }),
  },
  strictObject,
);

export type InvestigationBudgetsV1 = Static<
  typeof InvestigationBudgetsV1Schema
>;

const identifierPattern = "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$";
const policyVersionPattern = "^\\d+\\.\\d+\\.\\d+(?:-[a-z0-9.-]+)?$";
const assertionFieldPattern = "^[A-Za-z][A-Za-z0-9_]*$";

export const ClaimAssertionValueTypeV1Schema = Type.Union([
  Type.Literal("string"),
  Type.Literal("integer"),
  Type.Literal("json"),
  Type.Literal("json_primitive"),
]);

export type ClaimAssertionValueTypeV1 = Static<
  typeof ClaimAssertionValueTypeV1Schema
>;

const JsonPrimitiveV1Schema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);

export const ClaimAssertionFieldCapabilityV1Schema = Type.Object(
  {
    name: Type.String({ minLength: 1, pattern: assertionFieldPattern }),
    type: ClaimAssertionValueTypeV1Schema,
    required: Type.Literal(true),
    description: Type.String({ minLength: 1 }),
    minimum: Type.Optional(Type.Integer()),
    allowedValues: Type.Optional(
      Type.Array(JsonPrimitiveV1Schema, { minItems: 1, uniqueItems: true }),
    ),
  },
  strictObject,
);

export type ClaimAssertionFieldCapabilityV1 = Static<
  typeof ClaimAssertionFieldCapabilityV1Schema
>;

/**
 * Agent-visible description of one registered claim policy. This is a menu of
 * admissible claims, not a hint about which mechanism explains the current
 * investigation. The Harness still parses the assertion with the active
 * policy and independently evaluates its evidence.
 */
export const ClaimPolicyCapabilityV1Schema = Type.Object(
  {
    policyId: Type.String({ minLength: 1, pattern: identifierPattern }),
    policyVersion: Type.String({
      minLength: 1,
      pattern: policyVersionPattern,
    }),
    mechanismId: Type.String({ minLength: 1, pattern: identifierPattern }),
    assertionSchemaId: Type.String({ minLength: 1 }),
    mechanismDescription: Type.String({ minLength: 1 }),
    additionalProperties: Type.Literal(false),
    assertionFields: Type.Array(ClaimAssertionFieldCapabilityV1Schema, {
      minItems: 1,
    }),
    evidenceRequirements: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      uniqueItems: true,
    }),
  },
  strictObject,
);

export type ClaimPolicyCapabilityV1 = Static<
  typeof ClaimPolicyCapabilityV1Schema
>;

export const InvestigationCapabilityManifestV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    protocolVersion: Type.Literal("chronorift.investigation.v1"),
    capabilities: Type.Array(InvestigationCapabilityV1Schema, {
      minItems: 1,
      uniqueItems: true,
    }),
    claimPolicies: Type.Array(ClaimPolicyCapabilityV1Schema),
    budgets: InvestigationBudgetsV1Schema,
  },
  strictObject,
);

export type InvestigationCapabilityManifestV1 = Static<
  typeof InvestigationCapabilityManifestV1Schema
>;

export function isInvestigationCapabilityManifestV1(
  value: unknown,
): value is InvestigationCapabilityManifestV1 {
  return Check(InvestigationCapabilityManifestV1Schema, value);
}

export function parseInvestigationCapabilityManifestV1(
  value: unknown,
): InvestigationCapabilityManifestV1 {
  if (!isInvestigationCapabilityManifestV1(value)) {
    throw new TypeError("Invalid InvestigationCapabilityManifestV1");
  }
  const policyIds = value.claimPolicies.map((policy) => policy.policyId);
  const mechanismIds = value.claimPolicies.map((policy) => policy.mechanismId);
  const sortedPolicyIds = [...policyIds].sort((left, right) =>
    left.localeCompare(right),
  );
  const invalidPolicyCatalog =
    new Set(policyIds).size !== policyIds.length ||
    new Set(mechanismIds).size !== mechanismIds.length ||
    policyIds.some((policyId, index) => policyId !== sortedPolicyIds[index]) ||
    value.claimPolicies.some((policy) => {
      const fieldNames = policy.assertionFields.map((field) => field.name);
      return (
        policy.assertionSchemaId.trim() !== policy.assertionSchemaId ||
        policy.mechanismDescription.trim().length === 0 ||
        policy.evidenceRequirements.some(
          (requirement) => requirement.trim() !== requirement,
        ) ||
        new Set(fieldNames).size !== fieldNames.length ||
        policy.assertionFields.some((field) => {
          const allowedValues = field.allowedValues ?? [];
          return (
            field.description.trim().length === 0 ||
            (field.minimum !== undefined && field.type !== "integer") ||
            (field.type === "string" &&
              allowedValues.some((allowed) => typeof allowed !== "string")) ||
            (field.type === "integer" &&
              allowedValues.some(
                (allowed) =>
                  typeof allowed !== "number" ||
                  !Number.isInteger(allowed) ||
                  (field.minimum !== undefined && allowed < field.minimum),
              ))
          );
        })
      );
    });
  if (invalidPolicyCatalog) {
    throw new TypeError(
      "Invalid InvestigationCapabilityManifestV1 claim policy catalog",
    );
  }
  return value;
}
