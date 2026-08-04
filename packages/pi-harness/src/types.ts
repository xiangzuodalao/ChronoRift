export type JsonPrimitive = boolean | number | string | null;
export type JsonArray = readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export type AgentOutcome = "pass" | "fail" | "incomplete" | "mixed";

/**
 * Compact, JSON-friendly evidence exposed to the model. The adapter is
 * responsible for compiling raw telemetry into this representation.
 */
export interface AgentEvidence {
  readonly schemaVersion: 1;
  readonly evidenceId: string;
  readonly summary: string;
  readonly checkpointId: string;
  readonly branchId: string;
  readonly eventIds: readonly string[];
  readonly details: JsonObject;
}

export interface ForkTimelineRequest {
  readonly checkpointId: string;
  readonly controls: JsonObject;
  readonly label?: string;
}

export interface AgentTimelineBranch {
  readonly schemaVersion: 1;
  readonly branchId: string;
  readonly checkpointId: string;
  readonly controls: JsonObject;
}

export interface ReplayTimelineRequest {
  readonly branchId: string;
}

export interface AgentReplayResult {
  readonly schemaVersion: 1;
  readonly branchId: string;
  readonly outcome: AgentOutcome;
  readonly evidenceIds: readonly string[];
  readonly finalCheckpointId: string;
  readonly summary: string;
  readonly details: JsonObject;
}

export interface CompareTimelinesRequest {
  readonly baselineBranchId: string;
  readonly candidateBranchId: string;
}

export interface AgentTimelineComparison {
  readonly schemaVersion: 1;
  readonly baselineBranchId: string;
  readonly candidateBranchId: string;
  readonly baselineOutcome: AgentOutcome;
  readonly candidateOutcome: AgentOutcome;
  readonly evidenceIds: readonly string[];
  readonly firstDivergenceTick: number | null;
  readonly summary: string;
  readonly details: JsonObject;
}

/**
 * GameBranch-facing port. All requests and responses are serializable JSON so
 * the real GameBranch package can adapt to it without importing Pi SDK types.
 */
export interface AgentGameApi {
  getEvidence(evidenceId: string): Promise<AgentEvidence | null>;
  forkTimeline(request: ForkTimelineRequest): Promise<AgentTimelineBranch>;
  replayTimeline(request: ReplayTimelineRequest): Promise<AgentReplayResult>;
  compareTimelines(
    request: CompareTimelinesRequest,
  ): Promise<AgentTimelineComparison>;
}

export interface DiagnosisExperiment {
  readonly branchId: string;
  readonly outcome: AgentOutcome;
  readonly evidenceIds: readonly string[];
  readonly observation: string;
}

export interface DiagnosisComparison {
  readonly baselineBranchId: string;
  readonly candidateBranchId: string;
  readonly finding: string;
}

export interface DiagnosisReport {
  readonly schemaVersion: 1;
  readonly conclusion: string;
  readonly confidence: number;
  readonly evidenceIds: readonly string[];
  readonly experiments: readonly DiagnosisExperiment[];
  readonly comparisons: readonly DiagnosisComparison[];
  readonly suggestedFix: string;
}

export type PiThinkingLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiHarnessOptions {
  readonly cwd: string;
  readonly sourceRoot?: string;
  readonly runDir: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel?: PiThinkingLevel;
  readonly initialEvidenceId: string;
  readonly game: AgentGameApi;
  readonly additionalInstructions?: string;
}

export interface PiSessionReference {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: PiThinkingLevel;
}

export interface PiDiagnosisRunResult {
  readonly report: DiagnosisReport;
  readonly piSession: PiSessionReference;
}

export interface ListAvailablePiModelsOptions {
  readonly provider?: string;
}

export interface AvailablePiModel {
  readonly provider: string;
  readonly model: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly input: readonly string[];
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

export interface RestrictedSourceAccess {
  readonly root: string;
  read(request: SourceReadRequest): Promise<SourceReadResult>;
  search(request: SourceSearchRequest): Promise<SourceSearchResult>;
}
