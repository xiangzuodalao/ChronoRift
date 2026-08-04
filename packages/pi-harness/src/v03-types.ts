import type {
  BenchmarkArmV1,
  CapsuleId,
  DiagnosisProposalV2,
  EvidenceCapsuleV2,
  ExecutionId,
  ExperimentCandidateV1,
  InterventionId,
  V03ExecutionComparison,
  V03ExecutionLog,
} from "@chronorift/domain";

import type {
  PiSessionReference,
  PiThinkingLevel,
  RestrictedSourceAccess,
} from "./types.js";

export interface V03ReplayResult {
  readonly execution: V03ExecutionLog;
  readonly matches: boolean;
  readonly sourceDigest: string;
  readonly replayDigest: string;
}

export interface V03ExperimentResult {
  readonly execution: V03ExecutionLog;
  readonly interventionId: InterventionId;
}

export interface V03AgentGameApi {
  getEvidenceCapsule(capsuleId: CapsuleId): Promise<EvidenceCapsuleV2 | null>;
  getRawBaseline(executionId: ExecutionId): Promise<unknown>;
  replayExecution(executionId: ExecutionId): Promise<V03ReplayResult>;
  listExperiments(): Promise<readonly ExperimentCandidateV1[]>;
  runExperiment(
    baselineExecutionId: ExecutionId,
    interventionId: InterventionId,
  ): Promise<V03ExperimentResult>;
  compareExecutions(
    baselineExecutionId: ExecutionId,
    candidateExecutionId: ExecutionId,
  ): Promise<V03ExecutionComparison>;
}

interface V03HarnessBaseOptions {
  readonly cwd: string;
  readonly runDir: string;
  readonly arm: BenchmarkArmV1;
  readonly initialCapsuleId: string;
  readonly baselineExecutionId: string;
  readonly game: V03AgentGameApi;
  readonly source: RestrictedSourceAccess;
  readonly thinkingLevel?: PiThinkingLevel | undefined;
  readonly additionalInstructions?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface V03PiHarnessOptions extends V03HarnessBaseOptions {
  readonly provider: string;
  readonly model: string;
}

export type DeterministicV03PiHarnessOptions = V03HarnessBaseOptions;

export interface V03PiSessionReference extends PiSessionReference {
  readonly stats: {
    readonly toolCalls: number;
    readonly tokens: {
      readonly input: number;
      readonly output: number;
      readonly total: number;
    };
    readonly cost: number;
  };
}

export interface V03PiDiagnosisRunResult {
  readonly proposal: DiagnosisProposalV2;
  readonly piSession: V03PiSessionReference;
  readonly wallTimeMs: number;
}
