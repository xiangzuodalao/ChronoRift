import type { DiagnosisProposal, DiagnosisVerdict } from "@chronorift/domain";

import type { V01MockRunContext } from "./v01-runtime.js";

export interface PersistedV01Diagnosis {
  readonly proposal: DiagnosisProposal;
  readonly verdict: DiagnosisVerdict;
}

/** Persist the untrusted Agent proposal, then ask the Harness Gate to decide. */
export async function persistV01PiDiagnosis(
  context: V01MockRunContext,
  proposal: DiagnosisProposal,
): Promise<PersistedV01Diagnosis> {
  if (proposal.runId !== context.runId) {
    throw new Error(
      `Proposal ${proposal.proposalId} belongs to another investigation`,
    );
  }
  await context.repository.putDiagnosisProposal(proposal);
  const verdict = await context.gameBranch.conclude({
    proposalId: proposal.proposalId,
  });
  return { proposal, verdict };
}
