import type {
  CapsuleId,
  EvidenceCapsule,
  ExecutionComparison,
  RunId,
} from "@chronorift/domain";
import type { V01GameBranchService } from "@chronorift/gamebranch";
import {
  ArtifactNotFoundError,
  type V01JsonArtifactRepository,
} from "@chronorift/json-artifacts";
import type {
  AgentGameApi,
  AgentInterventionResult,
  AgentReplayResult,
  CompareExecutionsRequest,
  ReplayExecutionRequest,
  RunInterventionRequest,
} from "@chronorift/pi-harness";

/** Composition adapter that limits a Pi Session to one v0.1 investigation. */
export class ChronoRiftV01AgentGameApi implements AgentGameApi {
  constructor(
    private readonly runId: RunId,
    private readonly repository: V01JsonArtifactRepository,
    private readonly gameBranch: V01GameBranchService,
  ) {}

  async getEvidenceCapsule(
    capsuleId: CapsuleId,
  ): Promise<EvidenceCapsule | null> {
    try {
      const capsule = await this.repository.getEvidenceCapsule(capsuleId);
      return capsule.runId === this.runId ? capsule : null;
    } catch (error) {
      if (error instanceof ArtifactNotFoundError) return null;
      throw error;
    }
  }

  async replayExecution(
    request: ReplayExecutionRequest,
  ): Promise<AgentReplayResult> {
    await this.assertExecutionInRun(request.executionId);
    return this.gameBranch.replayExecution(request);
  }

  async runIntervention(
    request: RunInterventionRequest,
  ): Promise<AgentInterventionResult> {
    await this.assertExecutionInRun(request.baselineExecutionId);
    return this.gameBranch.runIntervention(request);
  }

  async compareExecutions(
    request: CompareExecutionsRequest,
  ): Promise<ExecutionComparison> {
    await Promise.all([
      this.assertExecutionInRun(request.baselineExecutionId),
      this.assertExecutionInRun(request.candidateExecutionId),
    ]);
    return this.gameBranch.compareExecutions(request);
  }

  private async assertExecutionInRun(
    executionId: ReplayExecutionRequest["executionId"],
  ): Promise<void> {
    const execution = await this.repository.getExecutionLog(executionId);
    if (execution.runId !== this.runId) {
      throw new Error(
        `Execution ${executionId} is outside investigation ${this.runId}`,
      );
    }
  }
}
