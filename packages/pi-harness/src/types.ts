import type {
  BranchSpec,
  CapsuleId,
  DiagnosisProposal,
  EvidenceCapsule,
  ExecutionComparison,
  ExecutionId,
  ExecutionLog,
} from "@chronorift/domain";

export type JsonPrimitive = boolean | number | string | null;
export type JsonArray = readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export interface ReplayExecutionRequest {
  readonly executionId: ExecutionId;
}

export interface AgentReplayResult {
  readonly execution: ExecutionLog;
  readonly matches: boolean;
  readonly sourceDigest: string;
  readonly replayDigest: string;
}

export interface RunInterventionRequest {
  readonly baselineExecutionId: ExecutionId;
  readonly deltaTicks: 1;
}

export interface AgentInterventionResult {
  readonly branch: BranchSpec;
  readonly execution: ExecutionLog;
}

export interface CompareExecutionsRequest {
  readonly baselineExecutionId: ExecutionId;
  readonly candidateExecutionId: ExecutionId;
}

/**
 * SDK-neutral boundary exposed to the Pi adapter. Implementations may compose
 * GameBranch services and repositories, but Pi types never cross this port.
 */
export interface AgentGameApi {
  getEvidenceCapsule(capsuleId: CapsuleId): Promise<EvidenceCapsule | null>;
  replayExecution(request: ReplayExecutionRequest): Promise<AgentReplayResult>;
  runIntervention(
    request: RunInterventionRequest,
  ): Promise<AgentInterventionResult>;
  compareExecutions(
    request: CompareExecutionsRequest,
  ): Promise<ExecutionComparison>;
}

export type PiThinkingLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiUsageStats {
  readonly toolCalls: number;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
  readonly cost: number;
}

interface PiHarnessBaseOptions {
  readonly cwd: string;
  readonly runDir: string;
  readonly initialCapsuleId: string;
  readonly game: AgentGameApi;
  readonly additionalInstructions?: string;
}

export interface PiHarnessOptions extends PiHarnessBaseOptions {
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel?: PiThinkingLevel;
}

export type DeterministicPiHarnessOptions = PiHarnessBaseOptions;

export interface PiSessionReference {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: PiThinkingLevel;
  readonly stats: PiUsageStats;
}

export interface PiDiagnosisRunResult {
  readonly proposal: DiagnosisProposal;
  readonly piSession: PiSessionReference;
}

export interface ListAvailablePiModelsOptions {
  readonly provider?: string;
}

export interface AssertPiModelCapabilitiesOptions {
  readonly provider: string;
  readonly model: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly thinkingLevel: PiThinkingLevel;
  readonly mappedThinkingValue: string;
}

export interface AvailablePiModel {
  readonly provider: string;
  readonly model: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly input: readonly string[];
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly thinkingLevelMap: Readonly<
    Partial<Record<PiThinkingLevel, string | null>>
  >;
}

export interface PersistPiApiKeyOptions {
  readonly provider: string;
  readonly apiKey: string;
}

export interface PersistPiApiKeyResult {
  readonly provider: string;
  readonly credentialType: "api_key";
}

export interface SourceReadRequest {
  readonly path: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface SourceReadResult {
  readonly path: string;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly truncated: boolean;
}

export interface SourceSearchRequest {
  readonly query: string;
  readonly path?: string;
  readonly includeSuffixes?: readonly string[];
  readonly caseSensitive?: boolean;
  readonly maxResults?: number;
}

export interface SourceSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

export interface SourceSearchResult {
  readonly query: string;
  readonly matches: readonly SourceSearchMatch[];
  readonly scannedFiles: number;
  readonly truncated: boolean;
}

export interface RestrictedSourceAccessOptions {
  readonly root: string;
  readonly maxFileBytes?: number;
  readonly maxReadLines?: number;
  readonly maxSearchFiles?: number;
}

export interface VirtualSourceFile {
  /** Agent-visible POSIX path. Formal benchmark views use `case/main.gd`. */
  readonly path: string;
  readonly content: string;
}

export interface VirtualSourceAccessOptions {
  readonly files: readonly VirtualSourceFile[];
  readonly maxReadLines?: number;
}

export interface RestrictedSourceAccess {
  readonly root: string;
  read(request: SourceReadRequest): Promise<SourceReadResult>;
  search(request: SourceSearchRequest): Promise<SourceSearchResult>;
}
