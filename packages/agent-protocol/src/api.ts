import type {
  DiagnosisProposalV4,
  EvidenceCapsuleV2,
  ExperimentCandidateV1,
  V03TelemetryEvent,
  V03ExecutionComparison,
  V03ExecutionLog,
} from "@chronorift/domain";
import { Type, type Static } from "typebox";

import type { InvestigationCapabilityManifestV1 } from "./capabilities.js";
import { ResourceHandleV1Schema, type ResourceHandleV1 } from "./handles.js";
import type { DiagnosisProposalDraftV1 } from "./proposal.js";

const strictObject = { additionalProperties: false } as const;
const nonEmptyString = Type.String({ minLength: 1 });

export const GetCapsuleInputV1Schema = Type.Object(
  { capsuleHandle: ResourceHandleV1Schema },
  strictObject,
);
export type GetCapsuleInputV1 = Static<typeof GetCapsuleInputV1Schema>;

export const ReplayExecutionInputV1Schema = Type.Object(
  { executionHandle: ResourceHandleV1Schema },
  strictObject,
);
export type ReplayExecutionInputV1 = Static<
  typeof ReplayExecutionInputV1Schema
>;

export const ListInterventionsInputV1Schema = Type.Object({}, strictObject);
export type ListInterventionsInputV1 = Static<
  typeof ListInterventionsInputV1Schema
>;

export const RunInterventionInputV1Schema = Type.Object(
  {
    baselineExecutionHandle: ResourceHandleV1Schema,
    interventionHandle: ResourceHandleV1Schema,
  },
  strictObject,
);
export type RunInterventionInputV1 = Static<
  typeof RunInterventionInputV1Schema
>;

export const CompareExecutionsInputV1Schema = Type.Object(
  {
    baselineExecutionHandle: ResourceHandleV1Schema,
    candidateExecutionHandle: ResourceHandleV1Schema,
  },
  strictObject,
);
export type CompareExecutionsInputV1 = Static<
  typeof CompareExecutionsInputV1Schema
>;

export const SourceReadInputV1Schema = Type.Object(
  {
    path: nonEmptyString,
    offset: Type.Optional(Type.Integer({ minimum: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  },
  strictObject,
);
export type SourceReadInputV1 = Static<typeof SourceReadInputV1Schema>;

export const SourceSearchInputV1Schema = Type.Object(
  {
    query: nonEmptyString,
    path: Type.Optional(nonEmptyString),
    includeSuffixes: Type.Optional(
      Type.Array(Type.String({ minLength: 2 }), {
        minItems: 1,
        uniqueItems: true,
      }),
    ),
    caseSensitive: Type.Optional(Type.Boolean()),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  strictObject,
);
export type SourceSearchInputV1 = Static<typeof SourceSearchInputV1Schema>;

export interface CapsuleAccessResultV1 {
  readonly capsuleHandle: ResourceHandleV1;
  readonly baselineExecutionHandle: ResourceHandleV1;
  readonly accessReceiptHandle: ResourceHandleV1;
  readonly capsule: EvidenceCapsuleV2;
  readonly events: readonly EventHandleResultV1[];
}

export interface EventHandleResultV1 {
  readonly eventHandle: ResourceHandleV1;
  readonly event: V03TelemetryEvent;
}

export interface ReplayExecutionResultV1 {
  readonly executionHandle: ResourceHandleV1;
  readonly accessReceiptHandle: ResourceHandleV1;
  readonly execution: V03ExecutionLog;
  readonly events: readonly EventHandleResultV1[];
  readonly matches: boolean;
  readonly sourceDigest: string;
  readonly replayDigest: string;
}

export interface InterventionCandidateV1 {
  readonly interventionHandle: ResourceHandleV1;
  readonly candidate: ExperimentCandidateV1;
}

export interface ListInterventionsResultV1 {
  readonly accessReceiptHandle: ResourceHandleV1;
  readonly interventions: readonly InterventionCandidateV1[];
}

export interface RunInterventionResultV1 {
  readonly interventionHandle: ResourceHandleV1;
  readonly executionHandle: ResourceHandleV1;
  readonly accessReceiptHandle: ResourceHandleV1;
  readonly execution: V03ExecutionLog;
  readonly events: readonly EventHandleResultV1[];
}

export interface CompareExecutionsResultV1 {
  readonly comparisonHandle: ResourceHandleV1;
  readonly accessReceiptHandle: ResourceHandleV1;
  readonly comparison: V03ExecutionComparison;
}

export interface SourceReadResultV1 {
  readonly accessReceiptHandle: ResourceHandleV1;
  readonly path: string;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly truncated: boolean;
}

export interface SourceSearchMatchV1 {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

export interface SourceSearchResultV1 {
  readonly accessReceiptHandle: ResourceHandleV1;
  readonly query: string;
  readonly matches: readonly SourceSearchMatchV1[];
  readonly scannedFiles: number;
  readonly truncated: boolean;
}

export interface SubmitProposalResultV1 {
  readonly accepted: true;
  readonly proposalHandle: ResourceHandleV1;
  readonly proposal: DiagnosisProposalV4;
}

/** A scoped, SDK-neutral capability surface supplied to one Agent Session. */
export interface InvestigationApiV1 {
  readonly manifest: InvestigationCapabilityManifestV1;
  getCapsule(input: GetCapsuleInputV1): Promise<CapsuleAccessResultV1>;
  replayExecution(
    input: ReplayExecutionInputV1,
  ): Promise<ReplayExecutionResultV1>;
  listInterventions(
    input: ListInterventionsInputV1,
  ): Promise<ListInterventionsResultV1>;
  runIntervention(
    input: RunInterventionInputV1,
  ): Promise<RunInterventionResultV1>;
  compareExecutions(
    input: CompareExecutionsInputV1,
  ): Promise<CompareExecutionsResultV1>;
  readSource(input: SourceReadInputV1): Promise<SourceReadResultV1>;
  searchSource(input: SourceSearchInputV1): Promise<SourceSearchResultV1>;
  submitProposal(
    draft: DiagnosisProposalDraftV1,
  ): Promise<SubmitProposalResultV1>;
}
