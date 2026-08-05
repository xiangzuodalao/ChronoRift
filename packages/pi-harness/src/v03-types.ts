import type {
  BenchmarkArmV1,
  CapsuleId,
  DiagnosisProposalV3,
  EvidenceAccessReceiptV1,
  EvidenceCapsuleV2,
  ExecutionId,
  ExperimentCandidateV1,
  FailureBriefV1,
  InterventionId,
  V03ExecutionComparison,
  V03ExecutionLog,
} from "@chronorift/domain";

import type {
  PiSessionReference,
  PiThinkingLevel,
  PiUsageStats,
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
  /** Optional monotonic counters exposed by instrumented adapters. */
  readonly baselineExecutions?: number | undefined;
  readonly diagnosticExecutions?: number | undefined;
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

export interface V03PiProgressSnapshot {
  readonly progressObserved: boolean;
  readonly toolCalls: number;
  readonly tokens: PiUsageStats["tokens"];
  readonly wallTimeMs: number;
}

export interface V03PiProgressSnapshotV3 {
  readonly schemaVersion: 3;
  /** Monotonic sequence within one Pi Session. */
  readonly sequence: number;
  readonly wallTimeMs: number;
  readonly fixtureStage: "fixture_validated";
  readonly model: {
    readonly requestStarted: boolean;
    readonly outputObserved: boolean;
    readonly turnCompleted: boolean;
    readonly tokens: PiUsageStats["tokens"];
  };
  readonly tools: {
    readonly started: number;
    readonly completed: number;
    readonly failed: number;
    readonly semanticRevision: number;
    readonly consecutiveNonProgressToolResults: number;
  };
  readonly game: {
    readonly baselineExecutions: number;
    readonly diagnosticExecutions: number;
  };
  readonly proposalSubmitted: boolean;
}

export interface V03AgentBudgets {
  readonly maxToolCalls: 12;
  /** Number of tool errors tolerated before termination; v0.3 tolerates none. */
  readonly maxToolErrors: 0;
  /** Successful tool results tolerated without semantic progress. */
  readonly maxConsecutiveNonProgressToolResults: 0;
}

export const V03_AGENT_BUDGETS: V03AgentBudgets = Object.freeze({
  maxToolCalls: 12,
  maxToolErrors: 0,
  maxConsecutiveNonProgressToolResults: 0,
});

interface V03HarnessBaseOptions {
  readonly cwd: string;
  readonly runDir: string;
  readonly arm: BenchmarkArmV1;
  readonly initialCapsuleId: string;
  readonly baselineExecutionId: string;
  readonly game: V03AgentGameApi;
  readonly source: RestrictedSourceAccess;
  /** Frozen, arm-independent input shown byte-for-byte to every treatment. */
  readonly failureBrief: FailureBriefV1;
  readonly thinkingLevel?: PiThinkingLevel | undefined;
  /** Formal runs disable Pi-internal retries so the outer attempt ledger owns them. */
  readonly sdkRetry?: boolean | undefined;
  readonly additionalInstructions?: string | undefined;
  readonly timeoutMs?: number | undefined;
  /** Deterministic evidence-receipt timestamp for preregistered runs. */
  readonly receiptIssuedAt?: string | undefined;
  readonly onProgress?:
    ((snapshot: V03PiProgressSnapshot) => Promise<void>) | undefined;
  /** Canonical structured progress for v0.3+ runtimes. */
  readonly onProgressV3?:
    ((snapshot: V03PiProgressSnapshotV3) => Promise<void>) | undefined;
}

export interface V03PiHarnessOptions extends V03HarnessBaseOptions {
  readonly provider: string;
  readonly model: string;
}

export type DeterministicV03PiHarnessOptions = V03HarnessBaseOptions;

export interface V03PiSessionReference extends PiSessionReference {
  readonly stats: PiUsageStats;
  readonly modelMetadata: {
    readonly name: string;
    readonly contextWindow: number;
    readonly maxTokens: number;
    readonly mappedThinkingValue: string | null;
  };
  readonly promptHashes: {
    readonly system: string;
    readonly user: string;
  };
}

export interface V03PiDiagnosisRunResult {
  readonly proposal: DiagnosisProposalV3;
  readonly accessReceipts: readonly EvidenceAccessReceiptV1[];
  readonly piSession: V03PiSessionReference;
  readonly wallTimeMs: number;
}
