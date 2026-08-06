import { JsonObjectSchema } from "@chronorift/domain";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

import { ResourceHandleV1Schema } from "./handles.js";

const strictObject = { additionalProperties: false } as const;
const nonEmptyString = Type.String({ minLength: 1 });
const uniqueHandles = () =>
  Type.Array(ResourceHandleV1Schema, { uniqueItems: true });

export const MechanismClaimDraftV1Schema = Type.Object(
  {
    kind: Type.Literal("mechanism"),
    mechanismId: nonEmptyString,
    assertion: Type.Object(
      {
        schemaId: nonEmptyString,
        payload: Type.Record(Type.String(), Type.Unknown()),
      },
      strictObject,
    ),
  },
  strictObject,
);

export const UnknownClaimDraftV1Schema = Type.Object(
  { kind: Type.Literal("unknown") },
  strictObject,
);

const draftCommon = {
  schemaVersion: Type.Literal(1),
  capsuleHandle: ResourceHandleV1Schema,
  baselineExecutionHandle: ResourceHandleV1Schema,
  replayExecutionHandle: Type.Optional(ResourceHandleV1Schema),
  candidateExecutionHandles: uniqueHandles(),
  comparisonHandles: uniqueHandles(),
  accessReceiptHandles: uniqueHandles(),
  summary: nonEmptyString,
  evidenceEventHandles: uniqueHandles(),
  suspectedSource: Type.Optional(
    Type.Object(
      {
        path: nonEmptyString,
        symbol: Type.Optional(nonEmptyString),
      },
      strictObject,
    ),
  ),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
} as const;

const MechanismProposalDraftV1Schema = Type.Object(
  {
    ...draftCommon,
    replayExecutionHandle: ResourceHandleV1Schema,
    candidateExecutionHandles: Type.Array(ResourceHandleV1Schema, {
      minItems: 1,
      uniqueItems: true,
    }),
    comparisonHandles: Type.Array(ResourceHandleV1Schema, {
      minItems: 1,
      uniqueItems: true,
    }),
    claim: MechanismClaimDraftV1Schema,
    blockers: Type.Array(nonEmptyString),
    nextExperiment: Type.Union([nonEmptyString, Type.Null()]),
  },
  strictObject,
);

const UnknownProposalDraftV1Schema = Type.Object(
  {
    ...draftCommon,
    claim: UnknownClaimDraftV1Schema,
    blockers: Type.Array(nonEmptyString, { minItems: 1 }),
    nextExperiment: nonEmptyString,
  },
  strictObject,
);

/**
 * Agent-authored input. Canonical scope and artifact IDs are intentionally
 * absent; an InvestigationApi bridge resolves handles and injects them.
 */
export const DiagnosisProposalDraftV1Schema = Type.Union([
  MechanismProposalDraftV1Schema,
  UnknownProposalDraftV1Schema,
]);

export type DiagnosisProposalDraftV1 = Static<
  typeof DiagnosisProposalDraftV1Schema
>;

export function isDiagnosisProposalDraftV1(
  value: unknown,
): value is DiagnosisProposalDraftV1 {
  if (!Check(DiagnosisProposalDraftV1Schema, value)) {
    return false;
  }
  return (
    value.claim.kind === "unknown" ||
    JsonObjectSchema.safeParse(value.claim.assertion.payload).success
  );
}

export function parseDiagnosisProposalDraftV1(
  value: unknown,
): DiagnosisProposalDraftV1 {
  if (!isDiagnosisProposalDraftV1(value)) {
    throw new TypeError("Invalid DiagnosisProposalDraftV1");
  }
  return value;
}
