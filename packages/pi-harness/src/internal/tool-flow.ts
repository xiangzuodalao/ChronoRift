import { PiHarnessError } from "../errors.js";
import type {
  AgentEvidence,
  AgentGameApi,
  AgentReplayResult,
  AgentTimelineBranch,
  AgentTimelineComparison,
  CompareTimelinesRequest,
  DiagnosisReport,
  ForkTimelineRequest,
  ReplayTimelineRequest,
} from "../types.js";
import {
  expectNonEmptyString,
  parseAgentEvidence,
  parseAgentReplayResult,
  parseAgentTimelineBranch,
  parseAgentTimelineComparison,
  parseCompareRequest,
  parseDiagnosisReport,
  parseForkRequest,
  parseReplayRequest,
} from "./contracts.js";

function comparisonKey(
  baselineBranchId: string,
  candidateBranchId: string,
): string {
  return `${baselineBranchId}\u0000${candidateBranchId}`;
}

/**
 * Stateful protocol boundary between model tools and GameBranch. It rejects IDs
 * that were not produced by prior tool calls and validates all adapter results.
 */
export class HarnessToolFlow {
  private readonly evidenceById = new Map<string, AgentEvidence>();
  private readonly knownCheckpointIds = new Set<string>();
  private readonly knownBranchIds = new Set<string>();
  private readonly forkedBranchIds = new Set<string>();
  private readonly replayByBranchId = new Map<string, AgentReplayResult>();
  private readonly comparisons = new Map<string, AgentTimelineComparison>();
  private readonly observedEvidenceIds = new Set<string>();
  private submittedReport: DiagnosisReport | undefined;

  constructor(private readonly game: AgentGameApi) {}

  private assertOpen(): void {
    if (this.submittedReport) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "The diagnosis has already been submitted; no further tool calls are allowed",
      );
    }
  }

  async getEvidence(evidenceIdInput: unknown): Promise<AgentEvidence> {
    this.assertOpen();
    const evidenceId = expectNonEmptyString(evidenceIdInput, "evidenceId");
    const raw = await this.game.getEvidence(evidenceId);
    if (raw === null) {
      throw new PiHarnessError(
        "INVALID_ARGUMENT",
        `Unknown evidenceId: ${evidenceId}`,
      );
    }
    const evidence = parseAgentEvidence(raw);
    if (evidence.evidenceId !== evidenceId) {
      throw new PiHarnessError(
        "INVALID_GAME_RESULT",
        `Evidence adapter returned ${evidence.evidenceId} for requested ${evidenceId}`,
      );
    }
    this.evidenceById.set(evidenceId, evidence);
    this.observedEvidenceIds.add(evidenceId);
    this.knownCheckpointIds.add(evidence.checkpointId);
    this.knownBranchIds.add(evidence.branchId);
    return evidence;
  }

  async forkTimeline(requestInput: unknown): Promise<AgentTimelineBranch> {
    this.assertOpen();
    const request: ForkTimelineRequest = parseForkRequest(requestInput);
    if (!this.knownCheckpointIds.has(request.checkpointId)) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        `Cannot fork unknown checkpointId ${request.checkpointId}; read evidence or replay results first`,
      );
    }
    const branch = parseAgentTimelineBranch(
      await this.game.forkTimeline(request),
    );
    if (branch.checkpointId !== request.checkpointId) {
      throw new PiHarnessError(
        "INVALID_GAME_RESULT",
        `Fork result checkpoint ${branch.checkpointId} does not match requested ${request.checkpointId}`,
      );
    }
    if (this.knownBranchIds.has(branch.branchId)) {
      throw new PiHarnessError(
        "INVALID_GAME_RESULT",
        `Fork returned duplicate branchId ${branch.branchId}`,
      );
    }
    this.knownBranchIds.add(branch.branchId);
    this.forkedBranchIds.add(branch.branchId);
    return branch;
  }

  async replayTimeline(requestInput: unknown): Promise<AgentReplayResult> {
    this.assertOpen();
    const request: ReplayTimelineRequest = parseReplayRequest(requestInput);
    if (!this.knownBranchIds.has(request.branchId)) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        `Cannot replay unknown branchId ${request.branchId}`,
      );
    }
    const replay = parseAgentReplayResult(
      await this.game.replayTimeline(request),
    );
    if (replay.branchId !== request.branchId) {
      throw new PiHarnessError(
        "INVALID_GAME_RESULT",
        `Replay result branch ${replay.branchId} does not match requested ${request.branchId}`,
      );
    }
    this.replayByBranchId.set(replay.branchId, replay);
    this.knownCheckpointIds.add(replay.finalCheckpointId);
    replay.evidenceIds.forEach((id) => this.observedEvidenceIds.add(id));
    return replay;
  }

  async compareTimelines(
    requestInput: unknown,
  ): Promise<AgentTimelineComparison> {
    this.assertOpen();
    const request: CompareTimelinesRequest = parseCompareRequest(requestInput);
    if (request.baselineBranchId === request.candidateBranchId) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "A branch cannot be compared with itself",
      );
    }
    const baseline = this.replayByBranchId.get(request.baselineBranchId);
    const candidate = this.replayByBranchId.get(request.candidateBranchId);
    if (!baseline || !candidate) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Both branches must be replayed before comparison",
      );
    }
    const comparison = parseAgentTimelineComparison(
      await this.game.compareTimelines(request),
    );
    if (
      comparison.baselineBranchId !== request.baselineBranchId ||
      comparison.candidateBranchId !== request.candidateBranchId
    ) {
      throw new PiHarnessError(
        "INVALID_GAME_RESULT",
        "Comparison result branch IDs do not match the request",
      );
    }
    if (
      comparison.baselineOutcome !== baseline.outcome ||
      comparison.candidateOutcome !== candidate.outcome
    ) {
      throw new PiHarnessError(
        "INVALID_GAME_RESULT",
        "Comparison outcomes do not match the replay results",
      );
    }
    this.comparisons.set(
      comparisonKey(request.baselineBranchId, request.candidateBranchId),
      comparison,
    );
    comparison.evidenceIds.forEach((id) => this.observedEvidenceIds.add(id));
    return comparison;
  }

  submitDiagnosis(value: unknown): DiagnosisReport {
    this.assertOpen();
    const report = parseDiagnosisReport(value);

    if (this.evidenceById.size === 0) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Read the initial evidence before submitting a diagnosis",
      );
    }
    if (this.forkedBranchIds.size === 0) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Create at least one experimental branch before submitting",
      );
    }
    if (this.comparisons.size === 0) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Compare replayed branches before submitting",
      );
    }

    for (const evidenceId of report.evidenceIds) {
      if (!this.observedEvidenceIds.has(evidenceId)) {
        throw new PiHarnessError(
          "INVALID_DIAGNOSIS",
          `Diagnosis references evidenceId ${evidenceId} that no tool returned`,
        );
      }
    }

    let includesForkedExperiment = false;
    for (const experiment of report.experiments) {
      const replay = this.replayByBranchId.get(experiment.branchId);
      if (!replay) {
        throw new PiHarnessError(
          "INVALID_DIAGNOSIS",
          `Experiment references branchId ${experiment.branchId} that was not replayed`,
        );
      }
      if (replay.outcome !== experiment.outcome) {
        throw new PiHarnessError(
          "INVALID_DIAGNOSIS",
          `Experiment outcome for ${experiment.branchId} is ${experiment.outcome}, but replay returned ${replay.outcome}`,
        );
      }
      const replayEvidenceIds = new Set(replay.evidenceIds);
      for (const evidenceId of experiment.evidenceIds) {
        if (!this.observedEvidenceIds.has(evidenceId)) {
          throw new PiHarnessError(
            "INVALID_DIAGNOSIS",
            `Experiment references evidenceId ${evidenceId} that no tool returned`,
          );
        }
        if (!replayEvidenceIds.has(evidenceId)) {
          throw new PiHarnessError(
            "INVALID_DIAGNOSIS",
            `Experiment references evidenceId ${evidenceId} that was not returned by replay ${experiment.branchId}`,
          );
        }
      }
      includesForkedExperiment ||= this.forkedBranchIds.has(
        experiment.branchId,
      );
    }
    if (!includesForkedExperiment) {
      throw new PiHarnessError(
        "INVALID_DIAGNOSIS",
        "At least one experiment must reference a branch created during this diagnosis",
      );
    }

    for (const comparison of report.comparisons) {
      if (
        !this.comparisons.has(
          comparisonKey(
            comparison.baselineBranchId,
            comparison.candidateBranchId,
          ),
        )
      ) {
        throw new PiHarnessError(
          "INVALID_DIAGNOSIS",
          `Diagnosis references comparison ${comparison.baselineBranchId} -> ${comparison.candidateBranchId} that was not performed`,
        );
      }
    }

    this.submittedReport = structuredClone(report);
    return structuredClone(report);
  }

  getSubmittedReport(): DiagnosisReport | undefined {
    return this.submittedReport
      ? structuredClone(this.submittedReport)
      : undefined;
  }
}
