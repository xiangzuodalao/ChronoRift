import {
  asCapsuleId,
  asExecutionId,
  asInterventionId,
  type CapsuleId,
  type EvidenceCapsuleV2,
  type ExecutionId,
  type ExperimentCandidateV1,
  type InterventionId,
  type V03ExecutionComparison,
} from "@chronorift/domain";
import type { V03AgentGameApi } from "@chronorift/pi-harness";

import type { V03RunContext } from "./v03-runtime.js";

/** Run-scoped adapter. It intentionally exposes no arbitrary artifact lookup. */
export class ChronoRiftV03AgentGameApi implements V03AgentGameApi {
  private executionCount = 1;
  private accessCount = 0;

  public constructor(private readonly context: V03RunContext) {}

  public get gameExecutions(): number {
    return this.executionCount;
  }

  /** Used only to distinguish no-progress infrastructure timeouts. */
  public get progressObserved(): boolean {
    return this.accessCount > 0;
  }

  public async getEvidenceCapsule(
    capsuleId: CapsuleId,
  ): Promise<EvidenceCapsuleV2 | null> {
    this.accessCount += 1;
    if (capsuleId !== this.context.evidenceCapsule.capsuleId) return null;
    return this.context.repository.getCapsule(asCapsuleId(capsuleId));
  }

  public async getRawBaseline(executionId: ExecutionId): Promise<unknown> {
    this.accessCount += 1;
    if (executionId !== this.context.baselineExecution.executionId) {
      throw new Error("Raw baseline request is outside this investigation");
    }
    return {
      schemaVersion: 1,
      execution: await this.context.repository.getExecution(
        asExecutionId(executionId),
      ),
    };
  }

  public async replayExecution(executionId: ExecutionId) {
    this.accessCount += 1;
    if (executionId !== this.context.baselineExecution.executionId) {
      throw new Error("Replay request is outside this investigation");
    }
    this.executionCount += 1;
    return this.context.gameBranch.replayExecution(asExecutionId(executionId));
  }

  public listExperiments(): Promise<readonly ExperimentCandidateV1[]> {
    this.accessCount += 1;
    return Promise.resolve(this.context.gameBranch.listExperiments());
  }

  public async runExperiment(
    baselineExecutionId: ExecutionId,
    interventionId: InterventionId,
  ) {
    this.accessCount += 1;
    if (baselineExecutionId !== this.context.baselineExecution.executionId) {
      throw new Error("Experiment baseline is outside this investigation");
    }
    this.executionCount += 1;
    const result = await this.context.gameBranch.runIntervention(
      asExecutionId(baselineExecutionId),
      asInterventionId(interventionId),
    );
    return { interventionId, execution: result.execution };
  }

  public compareExecutions(
    baselineExecutionId: ExecutionId,
    candidateExecutionId: ExecutionId,
  ): Promise<V03ExecutionComparison> {
    this.accessCount += 1;
    return this.context.gameBranch.compareExecutions(
      asExecutionId(baselineExecutionId),
      asExecutionId(candidateExecutionId),
    );
  }
}
