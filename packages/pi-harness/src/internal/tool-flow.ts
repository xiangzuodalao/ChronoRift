import type {
  ArtifactReference,
  DiagnosisProposal,
  EvidenceCapsule,
  ExecutionComparison,
  ExecutionId,
} from "@chronorift/domain";

import { PiHarnessError } from "../errors.js";
import type {
  AgentGameApi,
  AgentInterventionResult,
  AgentReplayResult,
} from "../types.js";
import {
  parseAgentInterventionResult,
  parseAgentReplayResult,
  parseCapsuleId,
  parseCompareRequest,
  parseDiagnosisProposal,
  parseEvidenceCapsule,
  parseExecutionComparison,
  parseReplayRequest,
  parseRunInterventionRequest,
} from "./contracts.js";

function asString(value: string): string {
  return value;
}

/**
 * Stateful capability boundary between model tools and GameBranch. It limits
 * v0.1 to one replay, one intervention, and one comparison, and rejects every
 * ID that was not established by an earlier tool result.
 */
export class HarnessToolFlow {
  private capsule: EvidenceCapsule | undefined;
  private replay: AgentReplayResult | undefined;
  private intervention: AgentInterventionResult | undefined;
  private comparison: ExecutionComparison | undefined;
  private submittedProposal: DiagnosisProposal | undefined;

  constructor(
    private readonly game: AgentGameApi,
    private readonly initialCapsuleId: string,
  ) {}

  private assertOpen(): void {
    if (this.submittedProposal) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "The diagnosis proposal has already been submitted; no further tool calls are allowed",
      );
    }
  }

  async getEvidenceCapsule(capsuleIdInput: unknown): Promise<EvidenceCapsule> {
    this.assertOpen();
    const capsuleId = parseCapsuleId(capsuleIdInput);
    if (asString(capsuleId) !== this.initialCapsuleId) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        `Cannot read capsule ${capsuleId}; only the initial capsule is in scope`,
      );
    }
    if (this.capsule) return structuredClone(this.capsule);

    const raw = await this.game.getEvidenceCapsule(capsuleId);
    if (raw === null) {
      throw new PiHarnessError(
        "INVALID_ARGUMENT",
        `Unknown capsuleId: ${capsuleId}`,
      );
    }
    const capsule = parseEvidenceCapsule(raw);
    if (asString(capsule.capsuleId) !== asString(capsuleId)) {
      throw new PiHarnessError(
        "INVALID_GAME_RESULT",
        `Capsule adapter returned ${capsule.capsuleId} for requested ${capsuleId}`,
      );
    }
    this.capsule = structuredClone(capsule);
    return structuredClone(capsule);
  }

  async replayExecution(requestInput: unknown): Promise<AgentReplayResult> {
    this.assertOpen();
    if (this.replay) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "v0.1 permits exactly one baseline replay per diagnosis",
      );
    }
    const capsule = this.requireCapsule("replay the baseline");
    const request = parseReplayRequest(requestInput);
    if (
      asString(request.executionId) !== asString(capsule.baselineExecutionId)
    ) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        `Cannot replay execution ${request.executionId}; the capsule baseline is ${capsule.baselineExecutionId}`,
      );
    }

    const replay = parseAgentReplayResult(
      await this.game.replayExecution(request),
    );
    if (
      asString(replay.execution.executionId) === asString(request.executionId)
    ) {
      throw new PiHarnessError(
        "INVALID_GAME_RESULT",
        "Replay must produce a new immutable ExecutionLog",
      );
    }
    if (asString(replay.execution.runId) !== asString(capsule.runId)) {
      throw new PiHarnessError(
        "INVALID_GAME_RESULT",
        "Replay execution belongs to a different investigation",
      );
    }
    if (
      asString(replay.execution.contractId) !== asString(capsule.contractId) ||
      asString(replay.execution.branchId) !== asString(capsule.branchId) ||
      asString(replay.execution.startCheckpointId) !==
        asString(capsule.checkpointId)
    ) {
      throw new PiHarnessError(
        "INVALID_GAME_RESULT",
        "Replay execution does not preserve the capsule Contract, branch, and start checkpoint",
      );
    }
    if (
      replay.sourceDigest !== capsule.integrity.timelineDigest ||
      replay.replayDigest !== replay.execution.timelineDigest
    ) {
      throw new PiHarnessError(
        "INVALID_GAME_RESULT",
        "Replay digest receipt does not match the capsule or replay ExecutionLog",
      );
    }
    if (replay.matches !== (replay.sourceDigest === replay.replayDigest)) {
      throw new PiHarnessError(
        "INVALID_GAME_RESULT",
        "Replay matches flag contradicts its source and replay digests",
      );
    }
    this.replay = structuredClone(replay);
    return structuredClone(replay);
  }

  async runIntervention(
    requestInput: unknown,
  ): Promise<AgentInterventionResult> {
    this.assertOpen();
    if (this.intervention) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "v0.1 permits exactly one intervention per diagnosis",
      );
    }
    const capsule = this.requireCapsule("run an intervention");
    if (!this.replay) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Replay the capsule baseline before running the intervention",
      );
    }
    const request = parseRunInterventionRequest(requestInput);
    if (
      asString(request.baselineExecutionId) !==
      asString(capsule.baselineExecutionId)
    ) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        `Cannot intervene on execution ${request.baselineExecutionId}; the capsule baseline is ${capsule.baselineExecutionId}`,
      );
    }

    const result = parseAgentInterventionResult(
      await this.game.runIntervention(request),
    );
    if (
      asString(result.execution.executionId) ===
        asString(capsule.baselineExecutionId) ||
      asString(result.execution.executionId) ===
        asString(this.replay.execution.executionId)
    ) {
      throw new PiHarnessError(
        "INVALID_GAME_RESULT",
        "Intervention must produce a new immutable ExecutionLog",
      );
    }
    if (
      asString(result.branch.branchId) !== asString(result.execution.branchId)
    ) {
      throw new PiHarnessError(
        "INVALID_GAME_RESULT",
        "Intervention BranchSpec and ExecutionLog branch IDs do not match",
      );
    }
    if (
      asString(result.branch.runId) !== asString(capsule.runId) ||
      asString(result.execution.runId) !== asString(capsule.runId)
    ) {
      throw new PiHarnessError(
        "INVALID_GAME_RESULT",
        "Intervention artifacts belong to a different investigation",
      );
    }
    if (
      result.branch.branchKind !== "intervention" ||
      result.branch.intervention.kind !== "delay_input" ||
      result.branch.intervention.deltaTicks !== 1 ||
      asString(result.branch.parentBranchId) !== asString(capsule.branchId)
    ) {
      throw new PiHarnessError(
        "INVALID_GAME_RESULT",
        "Intervention BranchSpec does not realize the requested single-tick delay",
      );
    }
    if (
      asString(result.branch.contractId) !== asString(capsule.contractId) ||
      asString(result.execution.contractId) !== asString(capsule.contractId) ||
      asString(result.branch.startCheckpointId) !==
        asString(capsule.checkpointId) ||
      asString(result.execution.startCheckpointId) !==
        asString(capsule.checkpointId) ||
      asString(result.branch.inputTraceId) !==
        asString(result.execution.inputTraceId)
    ) {
      throw new PiHarnessError(
        "INVALID_GAME_RESULT",
        "Intervention artifacts do not preserve Contract, checkpoint, and input-trace lineage",
      );
    }
    this.intervention = structuredClone(result);
    return structuredClone(result);
  }

  async compareExecutions(requestInput: unknown): Promise<ExecutionComparison> {
    this.assertOpen();
    if (this.comparison) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "v0.1 permits exactly one execution comparison per diagnosis",
      );
    }
    const capsule = this.requireCapsule("compare executions");
    if (!this.replay || !this.intervention) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Complete the baseline replay and intervention before comparison",
      );
    }
    const request = parseCompareRequest(requestInput);
    if (
      asString(request.baselineExecutionId) !==
        asString(this.replay.execution.executionId) ||
      asString(request.candidateExecutionId) !==
        asString(this.intervention.execution.executionId)
    ) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Comparison must use the replay and intervention executions returned in this diagnosis",
      );
    }

    const comparison = parseExecutionComparison(
      await this.game.compareExecutions(request),
    );
    if (
      asString(comparison.baselineExecutionId) !==
        asString(request.baselineExecutionId) ||
      asString(comparison.candidateExecutionId) !==
        asString(request.candidateExecutionId)
    ) {
      throw new PiHarnessError(
        "INVALID_GAME_RESULT",
        "Comparison result execution IDs do not match the request",
      );
    }
    if (asString(comparison.runId) !== asString(capsule.runId)) {
      throw new PiHarnessError(
        "INVALID_GAME_RESULT",
        "Comparison belongs to a different investigation",
      );
    }
    const replayOutcome =
      this.replay.execution.status === "completed"
        ? this.replay.execution.evaluation.status
        : "incomplete";
    const candidateOutcome =
      this.intervention.execution.status === "completed"
        ? this.intervention.execution.evaluation.status
        : "incomplete";
    if (
      asString(comparison.contractId) !== asString(capsule.contractId) ||
      asString(comparison.commonCheckpointId) !==
        asString(capsule.checkpointId) ||
      asString(comparison.baselineBranchId) !==
        asString(this.replay.execution.branchId) ||
      asString(comparison.candidateBranchId) !==
        asString(this.intervention.execution.branchId) ||
      comparison.intervention.kind !== "delay_input" ||
      comparison.intervention.deltaTicks !== 1 ||
      comparison.baselineOutcome !== replayOutcome ||
      comparison.candidateOutcome !== candidateOutcome
    ) {
      throw new PiHarnessError(
        "INVALID_GAME_RESULT",
        "Comparison result contradicts the Contract, checkpoint, branches, intervention, or execution outcomes",
      );
    }
    this.comparison = structuredClone(comparison);
    return structuredClone(comparison);
  }

  submitDiagnosisProposal(value: unknown): DiagnosisProposal {
    this.assertOpen();
    const capsule = this.requireCapsule("submit a proposal");
    const proposal = parseDiagnosisProposal(value);

    if (
      asString(proposal.runId) !== asString(capsule.runId) ||
      asString(proposal.capsuleId) !== asString(capsule.capsuleId) ||
      asString(proposal.baselineExecutionId) !==
        asString(capsule.baselineExecutionId)
    ) {
      throw new PiHarnessError(
        "INVALID_DIAGNOSIS",
        "Proposal run, capsule, or baseline execution reference is not the capsule observed in this session",
      );
    }

    if (proposal.claim.kind === "unknown") {
      if (
        (proposal.blockers.length === 0 && proposal.unknowns.length === 0) ||
        proposal.nextExperiment === null
      ) {
        throw new PiHarnessError(
          "INVALID_DIAGNOSIS",
          "An unknown proposal requires blockers or unknowns and a smallest next experiment",
        );
      }
      this.assertOptionalExperimentReferences(proposal);
    } else {
      const replay = this.requireReplay();
      const intervention = this.requireIntervention();
      const comparison = this.requireComparison();
      if (
        asString(proposal.replayExecutionId ?? "") !==
          asString(replay.execution.executionId) ||
        asString(proposal.candidateExecutionId ?? "") !==
          asString(intervention.execution.executionId) ||
        asString(proposal.comparisonId ?? "") !==
          asString(comparison.comparisonId)
      ) {
        throw new PiHarnessError(
          "INVALID_DIAGNOSIS",
          "Mechanism proposal must reference the replay, intervention, and comparison returned in this session",
        );
      }
    }

    for (const fact of proposal.observedFacts) {
      for (const reference of fact.references) {
        this.assertObservedReference(reference);
      }
    }

    this.submittedProposal = structuredClone(proposal);
    return structuredClone(proposal);
  }

  getSubmittedProposal(): DiagnosisProposal | undefined {
    return this.submittedProposal
      ? structuredClone(this.submittedProposal)
      : undefined;
  }

  private assertOptionalExperimentReferences(
    proposal: DiagnosisProposal,
  ): void {
    if (
      proposal.replayExecutionId !== undefined &&
      asString(proposal.replayExecutionId) !==
        asString(this.replay?.execution.executionId ?? "")
    ) {
      throw new PiHarnessError(
        "INVALID_DIAGNOSIS",
        "Unknown proposal references a replay execution not returned in this session",
      );
    }
    if (
      proposal.candidateExecutionId !== undefined &&
      asString(proposal.candidateExecutionId) !==
        asString(this.intervention?.execution.executionId ?? "")
    ) {
      throw new PiHarnessError(
        "INVALID_DIAGNOSIS",
        "Unknown proposal references a candidate execution not returned in this session",
      );
    }
    if (
      proposal.comparisonId !== undefined &&
      asString(proposal.comparisonId) !==
        asString(this.comparison?.comparisonId ?? "")
    ) {
      throw new PiHarnessError(
        "INVALID_DIAGNOSIS",
        "Unknown proposal references a comparison not returned in this session",
      );
    }
  }

  private assertObservedReference(reference: ArtifactReference): void {
    const capsule = this.requireCapsule("validate proposal references");
    const known = new Set<string>();
    const add = (kind: ArtifactReference["artifactKind"], id: string): void => {
      known.add(`${kind}\u0000${id}`);
    };

    add("capsule", capsule.capsuleId);
    add("contract", capsule.contractId);
    add("branch", capsule.branchId);
    add("checkpoint", capsule.checkpointId);
    add("execution", capsule.baselineExecutionId);
    for (const event of capsule.eventChain) add("event", event.eventId);

    for (const execution of [
      this.replay?.execution,
      this.intervention?.execution,
    ]) {
      if (!execution) continue;
      add("execution", execution.executionId);
      add("branch", execution.branchId);
      add("contract", execution.contractId);
      add("checkpoint", execution.startCheckpointId);
      if (execution.status === "completed") {
        add("checkpoint", execution.finalCheckpointId);
      }
      for (const event of execution.events) add("event", event.eventId);
    }
    if (this.intervention) add("branch", this.intervention.branch.branchId);
    if (this.comparison) {
      add("comparison", this.comparison.comparisonId);
      add("contract", this.comparison.contractId);
      add("checkpoint", this.comparison.commonCheckpointId);
      add("branch", this.comparison.baselineBranchId);
      add("branch", this.comparison.candidateBranchId);
      add("execution", this.comparison.baselineExecutionId);
      add("execution", this.comparison.candidateExecutionId);
    }

    const entry = (() => {
      switch (reference.artifactKind) {
        case "contract":
          return [reference.artifactKind, reference.contractId] as const;
        case "branch":
          return [reference.artifactKind, reference.branchId] as const;
        case "checkpoint":
          return [reference.artifactKind, reference.checkpointId] as const;
        case "execution":
          return [reference.artifactKind, reference.executionId] as const;
        case "capsule":
          return [reference.artifactKind, reference.capsuleId] as const;
        case "comparison":
          return [reference.artifactKind, reference.comparisonId] as const;
        case "event":
          return [reference.artifactKind, reference.eventId] as const;
      }
    })();
    if (!known.has(`${entry[0]}\u0000${entry[1]}`)) {
      throw new PiHarnessError(
        "INVALID_DIAGNOSIS",
        `Proposal references ${entry[0]} ${entry[1]} that no tool returned`,
      );
    }
  }

  private requireCapsule(action: string): EvidenceCapsule {
    if (!this.capsule) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        `Read the initial Evidence Capsule before attempting to ${action}`,
      );
    }
    return this.capsule;
  }

  private requireReplay(): AgentReplayResult {
    if (!this.replay) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Mechanism proposal requires the baseline replay",
      );
    }
    return this.replay;
  }

  private requireIntervention(): AgentInterventionResult {
    if (!this.intervention) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Mechanism proposal requires the one-tick intervention",
      );
    }
    return this.intervention;
  }

  private requireComparison(): ExecutionComparison {
    if (!this.comparison) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Mechanism proposal requires an execution comparison",
      );
    }
    return this.comparison;
  }
}

export function executionIdOf(result: {
  readonly execution: { readonly executionId: ExecutionId };
}): ExecutionId {
  return result.execution.executionId;
}
