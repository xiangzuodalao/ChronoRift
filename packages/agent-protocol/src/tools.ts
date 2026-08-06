import type { TSchema } from "typebox";

import {
  CompareExecutionsInputV1Schema,
  GetCapsuleInputV1Schema,
  ListInterventionsInputV1Schema,
  ReplayExecutionInputV1Schema,
  RunInterventionInputV1Schema,
  SourceReadInputV1Schema,
  SourceSearchInputV1Schema,
} from "./api.js";
import type { InvestigationCapabilityV1 } from "./capabilities.js";
import { DiagnosisProposalDraftV1Schema } from "./proposal.js";

export const INVESTIGATION_TOOL_NAMES_V1 = {
  getCapsule: "game_get_evidence_capsule_v4",
  replayExecution: "game_replay_execution_v4",
  listInterventions: "game_list_interventions_v4",
  runIntervention: "game_run_intervention_v4",
  compareExecutions: "game_compare_executions_v4",
  readSource: "source_read_v4",
  searchSource: "source_search_v4",
  submitProposal: "submit_diagnosis_proposal_v4",
} as const;

export type InvestigationToolNameV1 =
  (typeof INVESTIGATION_TOOL_NAMES_V1)[keyof typeof INVESTIGATION_TOOL_NAMES_V1];

/** Pi-neutral metadata that an SDK adapter can pass to its tool factory. */
export interface InvestigationToolMetadataV1 {
  readonly name: InvestigationToolNameV1;
  readonly label: string;
  readonly description: string;
  readonly capability: InvestigationCapabilityV1;
  readonly parameters: TSchema;
}

export const INVESTIGATION_TOOL_DEFINITIONS_V1: readonly InvestigationToolMetadataV1[] =
  Object.freeze([
    {
      name: INVESTIGATION_TOOL_NAMES_V1.getCapsule,
      label: "Read Evidence Capsule",
      description:
        "Call first. Read the immutable causal evidence Capsule and wait for its baselineExecutionHandle before the next evidence step.",
      capability: "capsule.read",
      parameters: GetCapsuleInputV1Schema,
    },
    {
      name: INVESTIGATION_TOOL_NAMES_V1.replayExecution,
      label: "Replay execution",
      description:
        "Call after reading the Capsule, using its baselineExecutionHandle. The strict replay must succeed before any intervention can run.",
      capability: "execution.replay",
      parameters: ReplayExecutionInputV1Schema,
    },
    {
      name: INVESTIGATION_TOOL_NAMES_V1.listInterventions,
      label: "List interventions",
      description:
        "Read-only: list the allowlisted single-variable interventions once after reading the Capsule. This catalog may be read before or after replay, but it must be read before running an intervention.",
      capability: "intervention.list",
      parameters: ListInterventionsInputV1Schema,
    },
    {
      name: INVESTIGATION_TOOL_NAMES_V1.runIntervention,
      label: "Run intervention",
      description:
        "Call only after one successful strict replay and after listing the catalog. Reserve and run one allowlisted intervention against the protected baseline.",
      capability: "intervention.run",
      parameters: RunInterventionInputV1Schema,
    },
    {
      name: INVESTIGATION_TOOL_NAMES_V1.compareExecutions,
      label: "Compare executions",
      description:
        "Call after an intervention succeeds. Compare the protected baseline with that returned intervention execution.",
      capability: "execution.compare",
      parameters: CompareExecutionsInputV1Schema,
    },
    {
      name: INVESTIGATION_TOOL_NAMES_V1.readSource,
      label: "Read source",
      description: "Read bounded text inside the investigation source root.",
      capability: "source.read",
      parameters: SourceReadInputV1Schema,
    },
    {
      name: INVESTIGATION_TOOL_NAMES_V1.searchSource,
      label: "Search source",
      description: "Search bounded text inside the investigation source root.",
      capability: "source.search",
      parameters: SourceSearchInputV1Schema,
    },
    {
      name: INVESTIGATION_TOOL_NAMES_V1.submitProposal,
      label: "Submit diagnosis proposal",
      description:
        "Final call: submit one handle-based diagnosis proposal after evidence gathering; only the Harness may emit a verdict.",
      capability: "proposal.submit",
      parameters: DiagnosisProposalDraftV1Schema,
    },
  ]);
