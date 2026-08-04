import { randomUUID } from "node:crypto";

import {
  asBranchId,
  asEvidenceId,
  asReportId,
  type DiagnosisBranchComparison,
  type DiagnosisReport,
  type RunManifest,
} from "@chronorift/domain";
import type { JsonArtifactRepository } from "@chronorift/json-artifacts";
import type {
  DiagnosisReport as PiDiagnosisReport,
  PiSessionReference,
} from "@chronorift/pi-harness";

import type { MockRunContext } from "./runtime.js";

const suspectedLocation = {
  path: "packages/mock-game/src/mock-game-environment.ts",
  symbol: "MockGameEnvironment.checkDoorTimer",
} as const;

export async function persistPiDiagnosis(
  context: MockRunContext,
  piReport: PiDiagnosisReport,
  session: PiSessionReference,
): Promise<DiagnosisReport> {
  const evidenceIds = piReport.evidenceIds.map((id) => asEvidenceId(id));
  if (evidenceIds.length === 0) {
    throw new Error("Pi diagnosis did not cite any evidence");
  }
  for (const evidenceId of evidenceIds) {
    const evidence = await context.repository.getEvidence(evidenceId);
    if (evidence.runId !== context.runId) {
      throw new Error(`Evidence ${evidenceId} belongs to another run`);
    }
  }

  const branchComparisons: DiagnosisBranchComparison[] = [];
  for (const item of piReport.comparisons) {
    const baselineBranchId = asBranchId(item.baselineBranchId);
    const experimentalBranchId = asBranchId(item.candidateBranchId);
    const comparison = await context.runner.compare(
      baselineBranchId,
      experimentalBranchId,
    );
    const baseline = await context.repository.getBranchRun(baselineBranchId);
    const experimental =
      await context.repository.getBranchRun(experimentalBranchId);
    const baselineEvaluation = baseline.evaluations[0];
    const experimentalEvaluation = experimental.evaluations[0];
    if (
      baselineEvaluation === undefined ||
      experimentalEvaluation === undefined
    ) {
      throw new Error("Compared branches must contain invariant evaluations");
    }
    branchComparisons.push({
      baselineBranchId,
      experimentalBranchId,
      changedControls: comparison.changedControls,
      baselineEvaluationId: baselineEvaluation.evaluationId,
      experimentalEvaluationId: experimentalEvaluation.evaluationId,
      observation: item.finding,
      interpretation: piReport.conclusion,
    });
  }

  const report: DiagnosisReport = {
    schemaVersion: 1,
    reportId: asReportId(`report:${randomUUID()}`),
    runId: context.runId,
    status:
      piReport.confidence >= 0.8
        ? "confirmed"
        : piReport.confidence >= 0.5
          ? "probable"
          : "inconclusive",
    conclusion: {
      summary: piReport.conclusion,
      mechanism: piReport.conclusion,
      category: "timing",
      suspectedLocations: [suspectedLocation],
    },
    confidence: piReport.confidence,
    evidenceIds,
    branchComparisons,
    suggestedFix: {
      summary: piReport.suggestedFix,
      targets: [suspectedLocation],
      strategy: piReport.suggestedFix,
      validationSteps: [
        "Replay the original 16,667 us baseline from the same checkpoint.",
        "Verify door.open becomes true without relying on an exact frame timestamp.",
        "Replay the 16,000 us control branch and compare invariant outcomes.",
      ],
    },
    limitations: [
      "The diagnosis is established against the deterministic Phase 1 Mock Game Environment.",
    ],
  };
  await context.repository.putDiagnosis(report);

  const manifest = await context.repository.getManifest(context.runId);
  const updated: RunManifest = {
    ...manifest,
    revision: manifest.revision + 1,
    model: {
      piSessionId: session.sessionId,
      provider: session.provider,
      model: session.model,
    },
    diagnosisReportId: report.reportId,
  };
  await context.repository.putManifest(updated, manifest.revision);
  return report;
}

export async function attachRequestedModel(
  repository: JsonArtifactRepository,
  manifest: RunManifest,
  provider: string,
  model: string,
): Promise<RunManifest> {
  const updated: RunManifest = {
    ...manifest,
    revision: manifest.revision + 1,
    model: { piSessionId: null, provider, model },
  };
  await repository.putManifest(updated, manifest.revision);
  return updated;
}
