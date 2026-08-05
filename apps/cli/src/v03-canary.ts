import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { JsonValue } from "@chronorift/domain";
import { canonicalJson, contentHash } from "@chronorift/json-artifacts";

export const LUNA_CANARY_PROVIDER = "openai-codex" as const;
export const LUNA_CANARY_MODEL = "gpt-5.6-luna" as const;
export const LUNA_CANARY_ADAPTER_CONTRACT =
  "benchmark-v3-canary-cell-runner-v1" as const;

export const CANARY_ARMS = [
  "generic",
  "evidence-only",
  "chronorift-full",
] as const;
export type CanaryArm = (typeof CANARY_ARMS)[number];
export type CanaryStage = "c0" | "c1";
export type CanaryFixture = "signal-ordering" | "physics-tunneling";
export type CanaryFailureKind = "infrastructure" | "diagnostic" | "invalid";
export type CanaryCellStatus =
  "scored" | "diagnostic_failure" | "infra_failure" | "invalid";

export type CanaryFailureCode =
  | "connection"
  | "timeout"
  | "http_408"
  | "http_429"
  | "http_5xx"
  | "auth"
  | "model_not_found"
  | "non_retryable_4xx"
  | "provider_error_unknown"
  | "aborted"
  | "invalid_tool_flow"
  | "progress_timeout"
  | "proposal_missing"
  | "invalid_proposal"
  | "budget_exhausted"
  | "agent_failed"
  | "model_configuration"
  | "harness_failure"
  | "unknown_failure";

export type CanaryProviderFailureCode = Extract<
  CanaryFailureCode,
  | "connection"
  | "timeout"
  | "http_408"
  | "http_429"
  | "http_5xx"
  | "auth"
  | "model_not_found"
  | "non_retryable_4xx"
  | "provider_error_unknown"
  | "aborted"
>;

export interface CanaryProviderFailureV2 {
  readonly phase: "request" | "response_stream";
  readonly code: CanaryProviderFailureCode;
  readonly httpStatus: number | null;
  readonly retryClass: "transient" | "permanent" | "unknown";
}

export interface LunaCanarySpecV1 {
  readonly schemaVersion: 1 | 2;
  readonly canaryId: string;
  readonly campaignTarget: "v0.3.2-luna";
  readonly adapterContract: typeof LUNA_CANARY_ADAPTER_CONTRACT;
  readonly model: {
    readonly provider: typeof LUNA_CANARY_PROVIDER;
    readonly model: typeof LUNA_CANARY_MODEL;
    readonly thinkingLevel: "max";
    readonly contextWindow: 272_000;
    readonly maxTokens: 128_000;
    readonly mappedThinkingValue: "max";
  };
  readonly budgets: {
    readonly timeoutMs: 600_000;
    readonly maxGameExecutions: 4;
    readonly maxToolCalls: 12;
    readonly maxToolErrors: 0;
    readonly maxConsecutiveNonProgressToolResults: 0;
  };
  readonly retryPolicy: {
    readonly maxAttemptsPerCell: 1;
    readonly providerInternalRetries: 0;
  };
  /** Present on hardened V2 specs; absent from historical V1 specs. */
  readonly implementationReceipt?: CanaryImplementationReceiptV2;
  readonly stages: readonly [
    {
      readonly stage: "c0";
      readonly stageId: "v0.3.2-luna-c0-001";
      readonly seed: "chronorift-v0.3.2-luna-canary-c0-1";
      readonly fixture: "signal-ordering";
      readonly arms: typeof CANARY_ARMS;
    },
    {
      readonly stage: "c1";
      readonly stageId: "v0.3.2-luna-c1-001";
      readonly seed: "chronorift-v0.3.2-luna-canary-c1-1";
      readonly fixture: "physics-tunneling";
      readonly arms: typeof CANARY_ARMS;
    },
  ];
  readonly specHash: string;
}

export interface CanaryTokenMetricsV1 {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
}

export interface CanaryFlowSummaryV1 {
  readonly evidenceReceiptCount: number;
  readonly rawExecutionReceiptCount: number;
  readonly capsuleReceiptCount: number;
  readonly sourceReceiptCount: number;
  readonly replayReceiptCount: number;
  readonly experimentReceiptCount: number;
  readonly comparisonReceiptCount: number;
  readonly matchingReplay: boolean;
  readonly interventionCount: number;
  readonly comparisonCount: number;
}

export interface CanaryScoredCellResultV1 {
  readonly sessionPersisted: true;
  readonly verdict: "confirmed" | "inconclusive";
  readonly mechanismCorrect: boolean;
  readonly flow: CanaryFlowSummaryV1;
  readonly progress: CanaryProgressSummaryV2;
  readonly metrics: {
    readonly gameExecutions: number;
    readonly toolCalls: number;
    readonly toolErrors: number;
    readonly maxConsecutiveNonProgressToolResults: number;
    readonly wallTimeMs: number;
    readonly tokens: CanaryTokenMetricsV1;
  };
}

/**
 * Monotonic facts last observed at the Pi adapter boundary. V1 reports did not
 * persist these facts, so newly created cells use schemaVersion 2 while the
 * parser continues to validate historical V1 publications byte-for-byte.
 */
export interface CanaryProgressSummaryV2 {
  readonly sequence: number;
  readonly fixtureValidated: boolean;
  readonly model: {
    readonly requestStarted: boolean;
    readonly outputObserved: boolean;
    readonly turnCompleted: boolean;
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

export interface CanaryCellReportV1 {
  readonly schemaVersion: 1 | 2;
  readonly canaryId: string;
  readonly specHash: string;
  readonly stage: CanaryStage;
  readonly stageId: string;
  readonly seed: string;
  readonly fixture: CanaryFixture;
  readonly arm: CanaryArm;
  readonly attemptOrdinal: 1;
  readonly status: CanaryCellStatus;
  readonly sessionPersisted: boolean;
  readonly proposalPresent: boolean;
  readonly verdict: "confirmed" | "inconclusive" | null;
  readonly mechanismCorrect: boolean | null;
  readonly incorrectConfirmation: boolean;
  readonly failureCode: CanaryFailureCode | null;
  /** Present on V2 cells; absent from immutable historical V1 cells. */
  readonly failureKind?: CanaryFailureKind | null;
  /** Typed provider facts when the adapter observed a provider failure. */
  readonly providerFailure?: CanaryProviderFailureV2 | null;
  readonly flow: CanaryFlowSummaryV1;
  /** Present on V2 cells; absent from immutable historical V1 cells. */
  readonly progress?: CanaryProgressSummaryV2;
  readonly metrics: {
    readonly gameExecutions: number;
    readonly toolCalls: number;
    readonly toolErrors: number;
    readonly maxConsecutiveNonProgressToolResults: number;
    readonly wallTimeMs: number;
    readonly tokens: CanaryTokenMetricsV1;
  };
  readonly cellHash: string;
}

export interface CanaryReadinessV1 {
  readonly status: "ready" | "not_ready";
  readonly reasons: readonly string[];
}

export interface CanaryStageReportV1 {
  readonly schemaVersion: 1 | 2;
  readonly spec: LunaCanarySpecV1;
  readonly stage: CanaryStage;
  readonly stageId: string;
  readonly seed: string;
  readonly armOrder: typeof CANARY_ARMS;
  readonly modelReceipt: CanaryModelReceiptV1;
  /** Present on V2 reports; absent from immutable historical V1 reports. */
  readonly implementationReceipt?: CanaryImplementationReceiptV2;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly prerequisiteReportHash: string | null;
  readonly cells: readonly CanaryCellReportV1[];
  readonly readiness: CanaryReadinessV1;
  readonly reportHash: string;
}

export interface CanaryModelReceiptV1 {
  readonly provider: string;
  readonly model: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly mappedThinkingValue: string | null;
}

export interface CanaryImplementationReceiptV2 {
  readonly gitCommit: string;
  readonly sourceHash: string;
  readonly sourceFileCount: number;
  readonly sourceWorktreeDirty: boolean;
}

export interface RunCanaryCellInput {
  readonly spec: LunaCanarySpecV1;
  readonly stage: CanaryStage;
  readonly fixture: CanaryFixture;
  readonly arm: CanaryArm;
}

/**
 * CLI-owned seam for the planned Benchmark V3 attempt adapter. Implementations
 * must perform exactly one provider attempt and must disable provider retries.
 */
export interface BenchmarkV3CanaryCellRunnerPort {
  implementationReceipt(
    spec: LunaCanarySpecV1,
  ): Promise<CanaryImplementationReceiptV2>;
  preflight(spec: LunaCanarySpecV1): Promise<CanaryModelReceiptV1>;
  runCell(input: RunCanaryCellInput): Promise<CanaryScoredCellResultV1>;
}

export class CanaryCellError extends Error {
  public readonly kind: CanaryFailureKind;
  public readonly sessionPersisted: boolean;
  public readonly proposalPresent: boolean;
  public readonly flow: CanaryFlowSummaryV1;
  public readonly progress: CanaryProgressSummaryV2;
  public readonly metrics: CanaryCellReportV1["metrics"];
  public readonly providerFailure: CanaryProviderFailureV2 | null;

  public constructor(
    public readonly code: CanaryFailureCode,
    observation: {
      readonly kind?: CanaryFailureKind | undefined;
      readonly sessionPersisted?: boolean | undefined;
      readonly proposalPresent?: boolean | undefined;
      readonly flow?: CanaryFlowSummaryV1 | undefined;
      readonly progress?: CanaryProgressSummaryV2 | undefined;
      readonly metrics?: CanaryCellReportV1["metrics"] | undefined;
      readonly providerFailure?: CanaryProviderFailureV2 | null | undefined;
    } = {},
  ) {
    super(code);
    this.name = "CanaryCellError";
    this.kind = observation.kind ?? failureKindForCode(code);
    this.sessionPersisted = observation.sessionPersisted ?? false;
    this.flow = observation.flow ?? zeroFlow();
    this.progress = observation.progress ?? zeroProgress();
    this.proposalPresent =
      observation.proposalPresent ?? this.progress.proposalSubmitted;
    this.metrics = observation.metrics ?? zeroMetrics();
    this.providerFailure = observation.providerFailure ?? null;
  }
}

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const CANARY_ID = /^v0\.3\.2-luna-canary-[a-z0-9][a-z0-9-]{0,47}$/u;
const STAGE_FIXTURES: Readonly<Record<CanaryStage, CanaryFixture>> = {
  c0: "signal-ordering",
  c1: "physics-tunneling",
};
const STAGE_IDENTITIES = {
  c0: {
    stageId: "v0.3.2-luna-c0-001",
    seed: "chronorift-v0.3.2-luna-canary-c0-1",
  },
  c1: {
    stageId: "v0.3.2-luna-c1-001",
    seed: "chronorift-v0.3.2-luna-canary-c1-1",
  },
} as const;
const FAILURE_CODES = new Set<CanaryFailureCode>([
  "connection",
  "timeout",
  "http_408",
  "http_429",
  "http_5xx",
  "auth",
  "model_not_found",
  "non_retryable_4xx",
  "provider_error_unknown",
  "aborted",
  "invalid_tool_flow",
  "progress_timeout",
  "proposal_missing",
  "invalid_proposal",
  "budget_exhausted",
  "agent_failed",
  "model_configuration",
  "harness_failure",
  "unknown_failure",
]);
const PROVIDER_FAILURE_CODES = new Set<CanaryProviderFailureCode>([
  "connection",
  "timeout",
  "http_408",
  "http_429",
  "http_5xx",
  "auth",
  "model_not_found",
  "non_retryable_4xx",
  "provider_error_unknown",
  "aborted",
]);

const zeroFlow = (): CanaryFlowSummaryV1 => ({
  evidenceReceiptCount: 0,
  rawExecutionReceiptCount: 0,
  capsuleReceiptCount: 0,
  sourceReceiptCount: 0,
  replayReceiptCount: 0,
  experimentReceiptCount: 0,
  comparisonReceiptCount: 0,
  matchingReplay: false,
  interventionCount: 0,
  comparisonCount: 0,
});

const zeroMetrics = (): CanaryCellReportV1["metrics"] => ({
  gameExecutions: 0,
  toolCalls: 0,
  toolErrors: 0,
  maxConsecutiveNonProgressToolResults: 0,
  wallTimeMs: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const zeroProgress = (): CanaryProgressSummaryV2 => ({
  sequence: 0,
  fixtureValidated: false,
  model: {
    requestStarted: false,
    outputObserved: false,
    turnCompleted: false,
  },
  tools: {
    started: 0,
    completed: 0,
    failed: 0,
    semanticRevision: 0,
    consecutiveNonProgressToolResults: 0,
  },
  game: { baselineExecutions: 0, diagnosticExecutions: 0 },
  proposalSubmitted: false,
});

export function failureKindForCode(code: CanaryFailureCode): CanaryFailureKind {
  switch (code) {
    case "connection":
    case "timeout":
    case "http_408":
    case "http_429":
    case "http_5xx":
    case "provider_error_unknown":
    case "aborted":
      return "infrastructure";
    case "invalid_tool_flow":
    case "progress_timeout":
    case "proposal_missing":
    case "invalid_proposal":
    case "budget_exhausted":
      return "diagnostic";
    case "auth":
    case "model_not_found":
    case "non_retryable_4xx":
    case "agent_failed":
    case "model_configuration":
    case "harness_failure":
    case "unknown_failure":
      return "invalid";
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (
    actual.length !== expected.size ||
    actual.some((key) => !expected.has(key))
  ) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  return value as number;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function expectIso(value: unknown, label: string): string {
  const text = expectString(value, label);
  if (!Number.isFinite(Date.parse(text)))
    throw new Error(`${label} is invalid`);
  return text;
}

function expectLiteral<T extends string | number>(
  value: unknown,
  literal: T,
  label: string,
): T {
  if (value !== literal) throw new Error(`${label} must be ${String(literal)}`);
  return literal;
}

function expectSha(value: unknown, label: string): string {
  const text = expectString(value, label);
  if (!SHA256.test(text)) throw new Error(`${label} must be a sha256 digest`);
  return text;
}

function parseArm(value: unknown, label: string): CanaryArm {
  if (!CANARY_ARMS.includes(value as CanaryArm)) {
    throw new Error(`${label} is not a canary arm`);
  }
  return value as CanaryArm;
}

function parseStage(value: unknown, label: string): CanaryStage {
  if (value !== "c0" && value !== "c1") {
    throw new Error(`${label} is not a canary stage`);
  }
  return value;
}

function parseFlow(value: unknown, label: string): CanaryFlowSummaryV1 {
  const record = objectValue(value, label);
  exactKeys(
    record,
    [
      "evidenceReceiptCount",
      "rawExecutionReceiptCount",
      "capsuleReceiptCount",
      "sourceReceiptCount",
      "replayReceiptCount",
      "experimentReceiptCount",
      "comparisonReceiptCount",
      "matchingReplay",
      "interventionCount",
      "comparisonCount",
    ],
    label,
  );
  if (typeof record["matchingReplay"] !== "boolean") {
    throw new Error(`${label}.matchingReplay must be boolean`);
  }
  return {
    evidenceReceiptCount: nonnegativeInteger(
      record["evidenceReceiptCount"],
      `${label}.evidenceReceiptCount`,
    ),
    rawExecutionReceiptCount: nonnegativeInteger(
      record["rawExecutionReceiptCount"],
      `${label}.rawExecutionReceiptCount`,
    ),
    capsuleReceiptCount: nonnegativeInteger(
      record["capsuleReceiptCount"],
      `${label}.capsuleReceiptCount`,
    ),
    sourceReceiptCount: nonnegativeInteger(
      record["sourceReceiptCount"],
      `${label}.sourceReceiptCount`,
    ),
    replayReceiptCount: nonnegativeInteger(
      record["replayReceiptCount"],
      `${label}.replayReceiptCount`,
    ),
    experimentReceiptCount: nonnegativeInteger(
      record["experimentReceiptCount"],
      `${label}.experimentReceiptCount`,
    ),
    comparisonReceiptCount: nonnegativeInteger(
      record["comparisonReceiptCount"],
      `${label}.comparisonReceiptCount`,
    ),
    matchingReplay: record["matchingReplay"],
    interventionCount: nonnegativeInteger(
      record["interventionCount"],
      `${label}.interventionCount`,
    ),
    comparisonCount: nonnegativeInteger(
      record["comparisonCount"],
      `${label}.comparisonCount`,
    ),
  };
}

function parseTokens(value: unknown, label: string): CanaryTokenMetricsV1 {
  const record = objectValue(value, label);
  exactKeys(
    record,
    ["input", "output", "cacheRead", "cacheWrite", "total"],
    label,
  );
  const parsed: CanaryTokenMetricsV1 = {
    input: nonnegativeInteger(record["input"], `${label}.input`),
    output: nonnegativeInteger(record["output"], `${label}.output`),
    cacheRead: nonnegativeInteger(record["cacheRead"], `${label}.cacheRead`),
    cacheWrite: nonnegativeInteger(record["cacheWrite"], `${label}.cacheWrite`),
    total: nonnegativeInteger(record["total"], `${label}.total`),
  };
  if (
    parsed.total !==
    parsed.input + parsed.output + parsed.cacheRead + parsed.cacheWrite
  ) {
    throw new Error(`${label}.total does not equal its token components`);
  }
  return parsed;
}

function parseMetrics(
  value: unknown,
  label: string,
): CanaryCellReportV1["metrics"] {
  const record = objectValue(value, label);
  exactKeys(
    record,
    [
      "gameExecutions",
      "toolCalls",
      "toolErrors",
      "maxConsecutiveNonProgressToolResults",
      "wallTimeMs",
      "tokens",
    ],
    label,
  );
  return {
    gameExecutions: nonnegativeInteger(
      record["gameExecutions"],
      `${label}.gameExecutions`,
    ),
    toolCalls: nonnegativeInteger(record["toolCalls"], `${label}.toolCalls`),
    toolErrors: nonnegativeInteger(record["toolErrors"], `${label}.toolErrors`),
    maxConsecutiveNonProgressToolResults: nonnegativeInteger(
      record["maxConsecutiveNonProgressToolResults"],
      `${label}.maxConsecutiveNonProgressToolResults`,
    ),
    wallTimeMs: nonnegativeInteger(record["wallTimeMs"], `${label}.wallTimeMs`),
    tokens: parseTokens(record["tokens"], `${label}.tokens`),
  };
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function parseProgress(value: unknown, label: string): CanaryProgressSummaryV2 {
  const record = objectValue(value, label);
  exactKeys(
    record,
    [
      "sequence",
      "fixtureValidated",
      "model",
      "tools",
      "game",
      "proposalSubmitted",
    ],
    label,
  );
  const model = objectValue(record["model"], `${label}.model`);
  exactKeys(
    model,
    ["requestStarted", "outputObserved", "turnCompleted"],
    `${label}.model`,
  );
  const tools = objectValue(record["tools"], `${label}.tools`);
  exactKeys(
    tools,
    [
      "started",
      "completed",
      "failed",
      "semanticRevision",
      "consecutiveNonProgressToolResults",
    ],
    `${label}.tools`,
  );
  const game = objectValue(record["game"], `${label}.game`);
  exactKeys(
    game,
    ["baselineExecutions", "diagnosticExecutions"],
    `${label}.game`,
  );
  const parsed: CanaryProgressSummaryV2 = {
    sequence: nonnegativeInteger(record["sequence"], `${label}.sequence`),
    fixtureValidated: expectBoolean(
      record["fixtureValidated"],
      `${label}.fixtureValidated`,
    ),
    model: {
      requestStarted: expectBoolean(
        model["requestStarted"],
        `${label}.model.requestStarted`,
      ),
      outputObserved: expectBoolean(
        model["outputObserved"],
        `${label}.model.outputObserved`,
      ),
      turnCompleted: expectBoolean(
        model["turnCompleted"],
        `${label}.model.turnCompleted`,
      ),
    },
    tools: {
      started: nonnegativeInteger(tools["started"], `${label}.tools.started`),
      completed: nonnegativeInteger(
        tools["completed"],
        `${label}.tools.completed`,
      ),
      failed: nonnegativeInteger(tools["failed"], `${label}.tools.failed`),
      semanticRevision: nonnegativeInteger(
        tools["semanticRevision"],
        `${label}.tools.semanticRevision`,
      ),
      consecutiveNonProgressToolResults: nonnegativeInteger(
        tools["consecutiveNonProgressToolResults"],
        `${label}.tools.consecutiveNonProgressToolResults`,
      ),
    },
    game: {
      baselineExecutions: nonnegativeInteger(
        game["baselineExecutions"],
        `${label}.game.baselineExecutions`,
      ),
      diagnosticExecutions: nonnegativeInteger(
        game["diagnosticExecutions"],
        `${label}.game.diagnosticExecutions`,
      ),
    },
    proposalSubmitted: expectBoolean(
      record["proposalSubmitted"],
      `${label}.proposalSubmitted`,
    ),
  };
  if (parsed.tools.completed + parsed.tools.failed > parsed.tools.started) {
    throw new Error(`${label}.tools terminal count exceeds started count`);
  }
  return parsed;
}

function parseImplementationReceipt(
  value: unknown,
  label: string,
): CanaryImplementationReceiptV2 {
  const record = objectValue(value, label);
  exactKeys(
    record,
    ["gitCommit", "sourceHash", "sourceFileCount", "sourceWorktreeDirty"],
    label,
  );
  const gitCommit = expectString(record["gitCommit"], `${label}.gitCommit`);
  if (!GIT_COMMIT.test(gitCommit)) {
    throw new Error(`${label}.gitCommit is not a full Git object ID`);
  }
  const sourceFileCount = nonnegativeInteger(
    record["sourceFileCount"],
    `${label}.sourceFileCount`,
  );
  if (sourceFileCount === 0) {
    throw new Error(`${label}.sourceFileCount must be positive`);
  }
  return {
    gitCommit,
    sourceHash: expectSha(record["sourceHash"], `${label}.sourceHash`),
    sourceFileCount,
    sourceWorktreeDirty: expectBoolean(
      record["sourceWorktreeDirty"],
      `${label}.sourceWorktreeDirty`,
    ),
  };
}

function parseProviderFailure(
  value: unknown,
  label: string,
): CanaryProviderFailureV2 {
  const record = objectValue(value, label);
  exactKeys(record, ["phase", "code", "httpStatus", "retryClass"], label);
  if (record["phase"] !== "request" && record["phase"] !== "response_stream") {
    throw new Error(`${label}.phase is invalid`);
  }
  if (
    !PROVIDER_FAILURE_CODES.has(record["code"] as CanaryProviderFailureCode)
  ) {
    throw new Error(`${label}.code is invalid`);
  }
  if (
    record["retryClass"] !== "transient" &&
    record["retryClass"] !== "permanent" &&
    record["retryClass"] !== "unknown"
  ) {
    throw new Error(`${label}.retryClass is invalid`);
  }
  const httpStatus =
    record["httpStatus"] === null
      ? null
      : nonnegativeInteger(record["httpStatus"], `${label}.httpStatus`);
  if (httpStatus !== null && (httpStatus < 100 || httpStatus > 599)) {
    throw new Error(`${label}.httpStatus is outside the HTTP status range`);
  }
  return {
    phase: record["phase"],
    code: record["code"] as CanaryProviderFailureCode,
    httpStatus,
    retryClass: record["retryClass"],
  };
}

type SpecHashBasis = Omit<LunaCanarySpecV1, "specHash">;
type CellHashBasis = Omit<CanaryCellReportV1, "cellHash">;
type ReportHashBasis = Omit<CanaryStageReportV1, "reportHash">;

const digest = (value: unknown): string => contentHash(value as JsonValue);

export function buildLunaCanarySpec(
  canaryId = "v0.3.2-luna-canary-005",
  implementationReceipt?: CanaryImplementationReceiptV2,
): LunaCanarySpecV1 {
  if (!CANARY_ID.test(canaryId)) {
    throw new Error("Canary ID is not a safe v0.3.2 Luna identity");
  }
  const basis: SpecHashBasis = {
    schemaVersion: implementationReceipt === undefined ? 1 : 2,
    canaryId,
    campaignTarget: "v0.3.2-luna",
    adapterContract: LUNA_CANARY_ADAPTER_CONTRACT,
    model: {
      provider: LUNA_CANARY_PROVIDER,
      model: LUNA_CANARY_MODEL,
      thinkingLevel: "max",
      contextWindow: 272_000,
      maxTokens: 128_000,
      mappedThinkingValue: "max",
    },
    budgets: {
      timeoutMs: 600_000,
      maxGameExecutions: 4,
      maxToolCalls: 12,
      maxToolErrors: 0,
      maxConsecutiveNonProgressToolResults: 0,
    },
    retryPolicy: { maxAttemptsPerCell: 1, providerInternalRetries: 0 },
    ...(implementationReceipt === undefined
      ? {}
      : {
          implementationReceipt: parseImplementationReceipt(
            implementationReceipt,
            "canary implementation receipt",
          ),
        }),
    stages: [
      {
        stage: "c0",
        stageId: "v0.3.2-luna-c0-001",
        seed: "chronorift-v0.3.2-luna-canary-c0-1",
        fixture: "signal-ordering",
        arms: CANARY_ARMS,
      },
      {
        stage: "c1",
        stageId: "v0.3.2-luna-c1-001",
        seed: "chronorift-v0.3.2-luna-canary-c1-1",
        fixture: "physics-tunneling",
        arms: CANARY_ARMS,
      },
    ],
  };
  return { ...basis, specHash: digest(basis) };
}

export function parseLunaCanarySpec(input: unknown): LunaCanarySpecV1 {
  const record = objectValue(input, "canary spec");
  const schemaVersion = record["schemaVersion"];
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    throw new Error("canary spec.schemaVersion must be 1 or 2");
  }
  exactKeys(
    record,
    [
      "schemaVersion",
      "canaryId",
      "campaignTarget",
      "adapterContract",
      "model",
      "budgets",
      "retryPolicy",
      ...(schemaVersion === 2 ? ["implementationReceipt"] : []),
      "stages",
      "specHash",
    ],
    "canary spec",
  );
  const canaryId = expectString(record["canaryId"], "canary spec.canaryId");
  if (!CANARY_ID.test(canaryId)) throw new Error("Invalid canary ID");
  expectLiteral(
    record["campaignTarget"],
    "v0.3.2-luna",
    "canary spec.campaignTarget",
  );
  const implementationReceipt =
    schemaVersion === 1
      ? undefined
      : parseImplementationReceipt(
          record["implementationReceipt"],
          "canary spec.implementationReceipt",
        );
  expectLiteral(
    record["adapterContract"],
    LUNA_CANARY_ADAPTER_CONTRACT,
    "canary spec.adapterContract",
  );

  const model = objectValue(record["model"], "canary spec.model");
  exactKeys(
    model,
    [
      "provider",
      "model",
      "thinkingLevel",
      "contextWindow",
      "maxTokens",
      "mappedThinkingValue",
    ],
    "canary spec.model",
  );
  expectLiteral(model["provider"], LUNA_CANARY_PROVIDER, "model.provider");
  expectLiteral(model["model"], LUNA_CANARY_MODEL, "model.model");
  expectLiteral(model["thinkingLevel"], "max", "model.thinkingLevel");
  expectLiteral(model["contextWindow"], 272_000, "model.contextWindow");
  expectLiteral(model["maxTokens"], 128_000, "model.maxTokens");
  expectLiteral(
    model["mappedThinkingValue"],
    "max",
    "model.mappedThinkingValue",
  );

  const budgets = objectValue(record["budgets"], "canary spec.budgets");
  exactKeys(
    budgets,
    [
      "timeoutMs",
      "maxGameExecutions",
      "maxToolCalls",
      "maxToolErrors",
      "maxConsecutiveNonProgressToolResults",
    ],
    "canary spec.budgets",
  );
  expectLiteral(budgets["timeoutMs"], 600_000, "budgets.timeoutMs");
  expectLiteral(budgets["maxGameExecutions"], 4, "budgets.maxGameExecutions");
  expectLiteral(budgets["maxToolCalls"], 12, "budgets.maxToolCalls");
  expectLiteral(budgets["maxToolErrors"], 0, "budgets.maxToolErrors");
  expectLiteral(
    budgets["maxConsecutiveNonProgressToolResults"],
    0,
    "budgets.maxConsecutiveNonProgressToolResults",
  );

  const retries = objectValue(record["retryPolicy"], "canary spec.retryPolicy");
  exactKeys(
    retries,
    ["maxAttemptsPerCell", "providerInternalRetries"],
    "canary spec.retryPolicy",
  );
  expectLiteral(
    retries["maxAttemptsPerCell"],
    1,
    "retryPolicy.maxAttemptsPerCell",
  );
  expectLiteral(
    retries["providerInternalRetries"],
    0,
    "retryPolicy.providerInternalRetries",
  );

  if (!Array.isArray(record["stages"]) || record["stages"].length !== 2) {
    throw new Error("Canary spec requires exactly C0 and C1");
  }
  record["stages"].forEach((value, index) => {
    const stage = objectValue(value, `canary spec.stages[${index}]`);
    exactKeys(
      stage,
      ["stage", "stageId", "seed", "fixture", "arms"],
      `stages[${index}]`,
    );
    const expectedStage = index === 0 ? "c0" : "c1";
    const expectedFixture = STAGE_FIXTURES[expectedStage];
    expectLiteral(stage["stage"], expectedStage, `stages[${index}].stage`);
    expectLiteral(
      stage["stageId"],
      STAGE_IDENTITIES[expectedStage].stageId,
      `stages[${index}].stageId`,
    );
    expectLiteral(
      stage["seed"],
      STAGE_IDENTITIES[expectedStage].seed,
      `stages[${index}].seed`,
    );
    expectLiteral(
      stage["fixture"],
      expectedFixture,
      `stages[${index}].fixture`,
    );
    if (
      !Array.isArray(stage["arms"]) ||
      stage["arms"].length !== CANARY_ARMS.length ||
      stage["arms"].some((arm, armIndex) => arm !== CANARY_ARMS[armIndex])
    ) {
      throw new Error(`stages[${index}].arms must contain the frozen arms`);
    }
  });
  const specHash = expectSha(record["specHash"], "canary spec.specHash");
  const parsed = {
    schemaVersion,
    canaryId,
    campaignTarget: "v0.3.2-luna",
    adapterContract: LUNA_CANARY_ADAPTER_CONTRACT,
    model: {
      provider: LUNA_CANARY_PROVIDER,
      model: LUNA_CANARY_MODEL,
      thinkingLevel: "max",
      contextWindow: 272_000,
      maxTokens: 128_000,
      mappedThinkingValue: "max",
    },
    budgets: {
      timeoutMs: 600_000,
      maxGameExecutions: 4,
      maxToolCalls: 12,
      maxToolErrors: 0,
      maxConsecutiveNonProgressToolResults: 0,
    },
    retryPolicy: { maxAttemptsPerCell: 1, providerInternalRetries: 0 },
    ...(implementationReceipt === undefined ? {} : { implementationReceipt }),
    stages: [
      {
        stage: "c0",
        stageId: "v0.3.2-luna-c0-001",
        seed: "chronorift-v0.3.2-luna-canary-c0-1",
        fixture: "signal-ordering",
        arms: CANARY_ARMS,
      },
      {
        stage: "c1",
        stageId: "v0.3.2-luna-c1-001",
        seed: "chronorift-v0.3.2-luna-canary-c1-1",
        fixture: "physics-tunneling",
        arms: CANARY_ARMS,
      },
    ],
    specHash,
  } satisfies LunaCanarySpecV1;
  const { specHash: ignored, ...basis } = parsed;
  void ignored;
  if (digest(basis) !== specHash) throw new Error("Canary spec hash mismatch");
  return parsed;
}

function cellHashBasis(cell: CanaryCellReportV1): CellHashBasis {
  const { cellHash, ...basis } = cell;
  void cellHash;
  return basis;
}

function parseCell(
  input: unknown,
  spec: LunaCanarySpecV1,
  stage: CanaryStage,
): CanaryCellReportV1 {
  const record = objectValue(input, "canary cell");
  const schemaVersion = record["schemaVersion"];
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    throw new Error("cell.schemaVersion must be 1 or 2");
  }
  exactKeys(
    record,
    [
      "schemaVersion",
      "canaryId",
      "specHash",
      "stage",
      "stageId",
      "seed",
      "fixture",
      "arm",
      "attemptOrdinal",
      "status",
      "sessionPersisted",
      "proposalPresent",
      "verdict",
      "mechanismCorrect",
      "incorrectConfirmation",
      "failureCode",
      ...(schemaVersion === 2 ? ["failureKind"] : []),
      ...(schemaVersion === 2 ? ["providerFailure"] : []),
      "flow",
      ...(schemaVersion === 2 ? ["progress"] : []),
      "metrics",
      "cellHash",
    ],
    "canary cell",
  );
  expectLiteral(record["canaryId"], spec.canaryId, "cell.canaryId");
  expectLiteral(record["specHash"], spec.specHash, "cell.specHash");
  expectLiteral(record["stage"], stage, "cell.stage");
  expectLiteral(
    record["stageId"],
    STAGE_IDENTITIES[stage].stageId,
    "cell.stageId",
  );
  expectLiteral(record["seed"], STAGE_IDENTITIES[stage].seed, "cell.seed");
  expectLiteral(record["fixture"], STAGE_FIXTURES[stage], "cell.fixture");
  expectLiteral(record["attemptOrdinal"], 1, "cell.attemptOrdinal");
  const arm = parseArm(record["arm"], "cell.arm");
  const status = record["status"];
  if (
    status !== "scored" &&
    status !== "diagnostic_failure" &&
    (schemaVersion === 1 ||
      (status !== "infra_failure" && status !== "invalid"))
  ) {
    throw new Error("cell.status is invalid");
  }
  if (
    typeof record["sessionPersisted"] !== "boolean" ||
    typeof record["proposalPresent"] !== "boolean" ||
    typeof record["incorrectConfirmation"] !== "boolean"
  ) {
    throw new Error("Cell boolean fields are invalid");
  }
  const verdict = record["verdict"];
  if (
    verdict !== null &&
    verdict !== "confirmed" &&
    verdict !== "inconclusive"
  ) {
    throw new Error("cell.verdict is invalid");
  }
  const mechanismCorrect = record["mechanismCorrect"];
  if (mechanismCorrect !== null && typeof mechanismCorrect !== "boolean") {
    throw new Error("cell.mechanismCorrect is invalid");
  }
  const rawFailure = record["failureCode"];
  const failureCode =
    rawFailure === null
      ? null
      : FAILURE_CODES.has(rawFailure as CanaryFailureCode)
        ? (rawFailure as CanaryFailureCode)
        : (() => {
            throw new Error("cell.failureCode is invalid");
          })();
  const failureKind =
    schemaVersion === 1
      ? undefined
      : record["failureKind"] === null
        ? null
        : record["failureKind"] === "infrastructure" ||
            record["failureKind"] === "diagnostic" ||
            record["failureKind"] === "invalid"
          ? record["failureKind"]
          : (() => {
              throw new Error("cell.failureKind is invalid");
            })();
  const providerFailure =
    schemaVersion === 1 || record["providerFailure"] === null
      ? null
      : parseProviderFailure(record["providerFailure"], "cell.providerFailure");
  const parsed: CanaryCellReportV1 = {
    schemaVersion,
    canaryId: spec.canaryId,
    specHash: spec.specHash,
    stage,
    stageId: STAGE_IDENTITIES[stage].stageId,
    seed: STAGE_IDENTITIES[stage].seed,
    fixture: STAGE_FIXTURES[stage],
    arm,
    attemptOrdinal: 1,
    status,
    sessionPersisted: record["sessionPersisted"],
    proposalPresent: record["proposalPresent"],
    verdict,
    mechanismCorrect,
    incorrectConfirmation: record["incorrectConfirmation"],
    failureCode,
    ...(failureKind === undefined ? {} : { failureKind }),
    ...(schemaVersion === 1 ? {} : { providerFailure }),
    flow: parseFlow(record["flow"], "cell.flow"),
    ...(schemaVersion === 1
      ? {}
      : { progress: parseProgress(record["progress"], "cell.progress") }),
    metrics: parseMetrics(record["metrics"], "cell.metrics"),
    cellHash: expectSha(record["cellHash"], "cell.cellHash"),
  };
  if (
    (status === "scored" &&
      (!parsed.proposalPresent ||
        !parsed.sessionPersisted ||
        parsed.verdict === null ||
        parsed.mechanismCorrect === null ||
        parsed.failureCode !== null)) ||
    (status !== "scored" &&
      ((schemaVersion === 1 &&
        (parsed.sessionPersisted || parsed.proposalPresent)) ||
        parsed.verdict !== null ||
        parsed.mechanismCorrect !== null ||
        parsed.failureCode === null))
  ) {
    throw new Error("Canary cell terminal fields contradict its status");
  }
  if (
    schemaVersion === 2 &&
    ((status === "scored" && parsed.failureKind !== null) ||
      (status === "diagnostic_failure" &&
        parsed.failureKind !== "diagnostic") ||
      (status === "infra_failure" && parsed.failureKind !== "infrastructure") ||
      (status === "invalid" && parsed.failureKind !== "invalid"))
  ) {
    throw new Error("Canary cell failure kind contradicts its status or code");
  }
  if (
    schemaVersion === 2 &&
    providerFailure !== null &&
    (providerFailure.code !== parsed.failureCode || status === "scored")
  ) {
    throw new Error("Canary provider failure contradicts its terminal cell");
  }
  if (
    schemaVersion === 2 &&
    (parsed.progress === undefined ||
      parsed.metrics.toolCalls < parsed.progress.tools.started ||
      parsed.metrics.toolErrors < parsed.progress.tools.failed ||
      parsed.metrics.maxConsecutiveNonProgressToolResults <
        parsed.progress.tools.consecutiveNonProgressToolResults)
  ) {
    throw new Error("Canary metrics regress from last observed progress");
  }
  if (
    schemaVersion === 2 &&
    parsed.proposalPresent !== parsed.progress?.proposalSubmitted
  ) {
    throw new Error("Canary proposal fact contradicts its observed progress");
  }
  if (
    parsed.incorrectConfirmation !==
    (parsed.verdict === "confirmed" && parsed.mechanismCorrect === false)
  ) {
    throw new Error("Canary cell incorrect confirmation is inconsistent");
  }
  if (digest(cellHashBasis(parsed)) !== parsed.cellHash) {
    throw new Error("Canary cell hash mismatch");
  }
  return parsed;
}

export function evaluateCanaryReadiness(
  spec: LunaCanarySpecV1,
  stage: CanaryStage,
  cells: readonly CanaryCellReportV1[],
): CanaryReadinessV1 {
  const reasons: string[] = [];
  if (
    cells.length !== CANARY_ARMS.length ||
    new Set(cells.map((cell) => cell.arm)).size !== CANARY_ARMS.length ||
    CANARY_ARMS.some((arm) => !cells.some((cell) => cell.arm === arm))
  ) {
    reasons.push("expected_three_unique_arms");
  }
  for (const arm of CANARY_ARMS) {
    const cell = cells.find((candidate) => candidate.arm === arm);
    if (cell === undefined) continue;
    if (cell.status !== "scored") {
      reasons.push(
        cell.status === "diagnostic_failure"
          ? `${arm}:failure:${cell.failureCode ?? "unknown_failure"}`
          : `${arm}:${cell.status}:${cell.failureCode ?? "unknown_failure"}`,
      );
      continue;
    }
    if (!cell.proposalPresent) reasons.push(`${arm}:proposal_missing`);
    if (cell.incorrectConfirmation)
      reasons.push(`${arm}:incorrect_confirmation`);
    if (cell.metrics.gameExecutions > spec.budgets.maxGameExecutions) {
      reasons.push(`${arm}:game_execution_budget_exceeded`);
    }
    if (cell.metrics.toolCalls > spec.budgets.maxToolCalls) {
      reasons.push(`${arm}:tool_call_budget_exceeded`);
    }
    if (cell.metrics.toolErrors > spec.budgets.maxToolErrors) {
      reasons.push(`${arm}:tool_error_budget_exceeded`);
    }
    if (
      cell.metrics.maxConsecutiveNonProgressToolResults >
      spec.budgets.maxConsecutiveNonProgressToolResults
    ) {
      reasons.push(`${arm}:non_progress_tool_result_budget_exceeded`);
    }
    if (cell.metrics.wallTimeMs > spec.budgets.timeoutMs) {
      reasons.push(`${arm}:timeout_budget_exceeded`);
    }
    if (arm === "generic") {
      if (cell.flow.rawExecutionReceiptCount < 1) {
        reasons.push("generic:raw_baseline_receipt_missing");
      }
      if (!cell.flow.matchingReplay || cell.flow.replayReceiptCount < 1) {
        reasons.push("generic:raw_replay_missing");
      }
      if (cell.flow.sourceReceiptCount < 1) {
        reasons.push("generic:source_receipt_missing");
      }
    }
    if (arm === "evidence-only") {
      if (cell.flow.capsuleReceiptCount < 1) {
        reasons.push("evidence-only:capsule_receipt_missing");
      }
      if (!cell.flow.matchingReplay || cell.flow.replayReceiptCount < 1) {
        reasons.push("evidence-only:strict_replay_missing");
      }
      if (cell.flow.sourceReceiptCount < 1) {
        reasons.push("evidence-only:source_receipt_missing");
      }
    }
    if (arm === "chronorift-full") {
      if (!cell.flow.matchingReplay || cell.flow.replayReceiptCount < 1) {
        reasons.push("chronorift-full:matching_replay_missing");
      }
      if (
        cell.flow.interventionCount < 1 ||
        cell.flow.experimentReceiptCount < 1
      ) {
        reasons.push("chronorift-full:intervention_missing");
      }
      if (
        cell.flow.comparisonCount < 1 ||
        cell.flow.comparisonReceiptCount < 1
      ) {
        reasons.push("chronorift-full:comparison_missing");
      }
      if (cell.flow.evidenceReceiptCount < 1) {
        reasons.push("chronorift-full:evidence_receipt_missing");
      }
      if (cell.flow.capsuleReceiptCount < 1) {
        reasons.push("chronorift-full:capsule_receipt_missing");
      }
      if (cell.flow.sourceReceiptCount < 1) {
        reasons.push("chronorift-full:source_receipt_missing");
      }
    }
  }
  return {
    status: reasons.length === 0 ? "ready" : "not_ready",
    reasons,
  };
}

function reportHashBasis(report: CanaryStageReportV1): ReportHashBasis {
  const { reportHash, ...basis } = report;
  void reportHash;
  return basis;
}

export function parseCanaryStageReport(input: unknown): CanaryStageReportV1 {
  const record = objectValue(input, "canary report");
  const schemaVersion = record["schemaVersion"];
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    throw new Error("report.schemaVersion must be 1 or 2");
  }
  exactKeys(
    record,
    [
      "schemaVersion",
      "spec",
      "stage",
      "stageId",
      "seed",
      "armOrder",
      "modelReceipt",
      ...(schemaVersion === 2 ? ["implementationReceipt"] : []),
      "startedAt",
      "finishedAt",
      "prerequisiteReportHash",
      "cells",
      "readiness",
      "reportHash",
    ],
    "canary report",
  );
  const spec = parseLunaCanarySpec(record["spec"]);
  const stage = parseStage(record["stage"], "report.stage");
  const stageIdentity = STAGE_IDENTITIES[stage];
  expectLiteral(record["stageId"], stageIdentity.stageId, "report.stageId");
  expectLiteral(record["seed"], stageIdentity.seed, "report.seed");
  if (
    !Array.isArray(record["armOrder"]) ||
    record["armOrder"].length !== CANARY_ARMS.length ||
    record["armOrder"].some((arm, index) => arm !== CANARY_ARMS[index])
  ) {
    throw new Error("report.armOrder does not match the frozen order");
  }
  const modelReceiptRecord = objectValue(
    record["modelReceipt"],
    "report.modelReceipt",
  );
  exactKeys(
    modelReceiptRecord,
    ["provider", "model", "contextWindow", "maxTokens", "mappedThinkingValue"],
    "report.modelReceipt",
  );
  const modelReceipt: CanaryModelReceiptV1 = {
    provider: expectString(
      modelReceiptRecord["provider"],
      "modelReceipt.provider",
    ),
    model: expectString(modelReceiptRecord["model"], "modelReceipt.model"),
    contextWindow: nonnegativeInteger(
      modelReceiptRecord["contextWindow"],
      "modelReceipt.contextWindow",
    ),
    maxTokens: nonnegativeInteger(
      modelReceiptRecord["maxTokens"],
      "modelReceipt.maxTokens",
    ),
    mappedThinkingValue:
      modelReceiptRecord["mappedThinkingValue"] === null
        ? null
        : expectString(
            modelReceiptRecord["mappedThinkingValue"],
            "modelReceipt.mappedThinkingValue",
          ),
  };
  assertModelReceipt(spec, modelReceipt);
  const implementationReceipt =
    schemaVersion === 1
      ? undefined
      : parseImplementationReceipt(
          record["implementationReceipt"],
          "report.implementationReceipt",
        );
  if (spec.schemaVersion !== schemaVersion) {
    throw new Error("Canary report and spec schema versions do not match");
  }
  if (
    schemaVersion === 2 &&
    canonicalJson(spec.implementationReceipt as unknown as JsonValue) !==
      canonicalJson(implementationReceipt as unknown as JsonValue)
  ) {
    throw new Error("Canary report implementation does not match its spec");
  }
  const startedAt = expectIso(record["startedAt"], "report.startedAt");
  const finishedAt = expectIso(record["finishedAt"], "report.finishedAt");
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new Error("Canary report completion precedes its start");
  }
  const prerequisiteReportHash =
    record["prerequisiteReportHash"] === null
      ? null
      : expectSha(
          record["prerequisiteReportHash"],
          "report.prerequisiteReportHash",
        );
  if (
    (stage === "c0" && prerequisiteReportHash !== null) ||
    (stage === "c1" && prerequisiteReportHash === null)
  ) {
    throw new Error("Canary report prerequisite does not match its stage");
  }
  if (!Array.isArray(record["cells"])) {
    throw new Error("report.cells must be an array");
  }
  const cells = record["cells"].map((cell) => parseCell(cell, spec, stage));
  if (
    cells.length !== CANARY_ARMS.length ||
    cells.some(
      (cell, index) =>
        cell.arm !== CANARY_ARMS[index] || cell.schemaVersion !== schemaVersion,
    )
  ) {
    throw new Error(
      "Canary report cells do not match its schema and frozen arm order",
    );
  }
  const readinessRecord = objectValue(record["readiness"], "report.readiness");
  exactKeys(readinessRecord, ["status", "reasons"], "report.readiness");
  if (
    readinessRecord["status"] !== "ready" &&
    readinessRecord["status"] !== "not_ready"
  ) {
    throw new Error("report.readiness.status is invalid");
  }
  if (
    !Array.isArray(readinessRecord["reasons"]) ||
    readinessRecord["reasons"].some(
      (reason) => typeof reason !== "string" || reason.length === 0,
    )
  ) {
    throw new Error("report.readiness.reasons is invalid");
  }
  const readiness = evaluateCanaryReadiness(spec, stage, cells);
  if (
    canonicalJson(readiness as unknown as JsonValue) !==
    canonicalJson(readinessRecord as unknown as JsonValue)
  ) {
    throw new Error("Canary readiness does not match the cell evidence");
  }
  const parsed: CanaryStageReportV1 = {
    schemaVersion,
    spec,
    stage,
    stageId: stageIdentity.stageId,
    seed: stageIdentity.seed,
    armOrder: CANARY_ARMS,
    modelReceipt,
    ...(implementationReceipt === undefined ? {} : { implementationReceipt }),
    startedAt,
    finishedAt,
    prerequisiteReportHash,
    cells,
    readiness,
    reportHash: expectSha(record["reportHash"], "report.reportHash"),
  };
  if (digest(reportHashBasis(parsed)) !== parsed.reportHash) {
    throw new Error("Canary report hash mismatch");
  }
  return parsed;
}

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

const isContained = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
};

async function ensureRealDirectoryTree(
  trustedRoot: string,
  directory: string,
): Promise<string> {
  const root = resolve(trustedRoot);
  const target = resolve(directory);
  if (!isContained(root, target)) {
    throw new Error("Canary artifact path escapes its trusted root");
  }
  await mkdir(root, { recursive: true });
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("Canary artifact root is not a real directory");
  }
  let current = root;
  for (const segment of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("Canary artifact directory is unsafe");
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      await mkdir(current);
    }
  }
  const canonicalRoot = await realpath(root);
  const canonicalTarget = await realpath(target);
  if (!isContained(canonicalRoot, canonicalTarget)) {
    throw new Error("Canary artifact directory resolves outside its root");
  }
  return canonicalTarget;
}

async function writeOnce(
  trustedRoot: string,
  path: string,
  value: unknown,
): Promise<void> {
  const parent = await ensureRealDirectoryTree(trustedRoot, dirname(path));
  const finalPath = resolve(path);
  if (!isContained(parent, finalPath)) {
    throw new Error("Canary artifact filename escapes its directory");
  }
  const temporary = join(parent, `.${process.pid}-${randomUUID()}.canary`);
  let created = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(`${canonicalJson(value as JsonValue)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, finalPath);
    const directory = await open(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (created) await unlink(temporary).catch(() => undefined);
  }
}

async function readJson(path: string): Promise<unknown> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Canary artifact is not a regular file");
  }
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export class V03CanaryJsonLedger {
  private readonly trustedRoot: string;
  private readonly directory: string;

  public constructor(
    cwd: string,
    artifactRoot: string,
    private readonly canaryId: string,
  ) {
    if (!CANARY_ID.test(canaryId)) throw new Error("Unsafe canary ID");
    const workspace = resolve(cwd);
    this.trustedRoot = resolve(artifactRoot);
    if (!isContained(workspace, this.trustedRoot)) {
      throw new Error("Canary artifact root must stay inside the workspace");
    }
    this.directory = join(
      this.trustedRoot,
      "v0.3",
      "canaries",
      encodeURIComponent(canaryId),
    );
  }

  private stageDirectory(stage: CanaryStage): string {
    return join(this.directory, "stages", STAGE_IDENTITIES[stage].stageId);
  }

  public async putSpec(spec: LunaCanarySpecV1): Promise<void> {
    const path = join(this.directory, "spec.json");
    try {
      await writeOnce(this.trustedRoot, path, spec);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const existing = parseLunaCanarySpec(await readJson(path));
      if (
        canonicalJson(existing as unknown as JsonValue) !==
        canonicalJson(spec as unknown as JsonValue)
      ) {
        throw new Error("Canary definition conflicts with stored spec");
      }
    }
  }

  public async hasStarted(stage: CanaryStage): Promise<boolean> {
    try {
      await readJson(join(this.stageDirectory(stage), "started.json"));
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }

  public putStarted(stage: CanaryStage, startedAt: string): Promise<void> {
    return writeOnce(
      this.trustedRoot,
      join(this.stageDirectory(stage), "started.json"),
      {
        schemaVersion: 1,
        canaryId: this.canaryId,
        stage,
        stageId: STAGE_IDENTITIES[stage].stageId,
        seed: STAGE_IDENTITIES[stage].seed,
        armOrder: CANARY_ARMS,
        startedAt,
        retryPolicy: "single-attempt-no-resume-v1",
      },
    );
  }

  public putCell(cell: CanaryCellReportV1): Promise<void> {
    return writeOnce(
      this.trustedRoot,
      join(this.stageDirectory(cell.stage), "cells", `${cell.arm}.json`),
      cell,
    );
  }

  public putReport(report: CanaryStageReportV1): Promise<void> {
    return writeOnce(
      this.trustedRoot,
      join(this.stageDirectory(report.stage), "report.json"),
      report,
    );
  }

  public async getReport(
    stage: CanaryStage,
  ): Promise<CanaryStageReportV1 | null> {
    try {
      const report = parseCanaryStageReport(
        await readJson(join(this.stageDirectory(stage), "report.json")),
      );
      if (report.spec.canaryId !== this.canaryId || report.stage !== stage) {
        throw new Error("Canary report does not belong to its ledger location");
      }
      return report;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }
}

function assertModelReceipt(
  spec: LunaCanarySpecV1,
  receipt: CanaryModelReceiptV1,
): void {
  if (
    receipt.provider !== spec.model.provider ||
    receipt.model !== spec.model.model ||
    receipt.contextWindow !== spec.model.contextWindow ||
    receipt.maxTokens !== spec.model.maxTokens ||
    receipt.mappedThinkingValue !== spec.model.mappedThinkingValue
  ) {
    throw new Error("Canary model receipt does not match the frozen spec");
  }
}

function buildScoredCell(
  spec: LunaCanarySpecV1,
  stage: CanaryStage,
  fixture: CanaryFixture,
  arm: CanaryArm,
  result: CanaryScoredCellResultV1,
): CanaryCellReportV1 {
  const basis: CellHashBasis = {
    schemaVersion: 2,
    canaryId: spec.canaryId,
    specHash: spec.specHash,
    stage,
    stageId: STAGE_IDENTITIES[stage].stageId,
    seed: STAGE_IDENTITIES[stage].seed,
    fixture,
    arm,
    attemptOrdinal: 1,
    status: "scored",
    sessionPersisted: result.sessionPersisted,
    proposalPresent: true,
    verdict: result.verdict,
    mechanismCorrect: result.mechanismCorrect,
    incorrectConfirmation:
      result.verdict === "confirmed" && !result.mechanismCorrect,
    failureCode: null,
    failureKind: null,
    providerFailure: null,
    flow: parseFlow(result.flow, "runner result.flow"),
    progress: parseProgress(result.progress, "runner result.progress"),
    metrics: parseMetrics(result.metrics, "runner result.metrics"),
  };
  return { ...basis, cellHash: digest(basis) };
}

function buildFailureCell(
  spec: LunaCanarySpecV1,
  stage: CanaryStage,
  fixture: CanaryFixture,
  arm: CanaryArm,
  error: CanaryCellError,
): CanaryCellReportV1 {
  const status: Exclude<CanaryCellStatus, "scored"> =
    error.kind === "infrastructure"
      ? "infra_failure"
      : error.kind === "diagnostic"
        ? "diagnostic_failure"
        : "invalid";
  const basis: CellHashBasis = {
    schemaVersion: 2,
    canaryId: spec.canaryId,
    specHash: spec.specHash,
    stage,
    stageId: STAGE_IDENTITIES[stage].stageId,
    seed: STAGE_IDENTITIES[stage].seed,
    fixture,
    arm,
    attemptOrdinal: 1,
    status,
    sessionPersisted: error.sessionPersisted,
    proposalPresent: error.proposalPresent,
    verdict: null,
    mechanismCorrect: null,
    incorrectConfirmation: false,
    failureCode: error.code,
    failureKind: error.kind,
    providerFailure: error.providerFailure,
    flow: parseFlow(error.flow, "runner failure.flow"),
    progress: parseProgress(error.progress, "runner failure.progress"),
    metrics: parseMetrics(error.metrics, "runner failure.metrics"),
  };
  return { ...basis, cellHash: digest(basis) };
}

const classifyCellError = (error: unknown): CanaryCellError =>
  error instanceof CanaryCellError
    ? error
    : new CanaryCellError("unknown_failure", { kind: "invalid" });

export interface ExecuteCanaryStageOptions {
  readonly cwd: string;
  readonly artifactRoot: string;
  readonly spec: LunaCanarySpecV1;
  readonly stage: CanaryStage;
  readonly runner: BenchmarkV3CanaryCellRunnerPort;
  readonly prerequisiteReport?: CanaryStageReportV1 | undefined;
  readonly nowIso?: (() => string) | undefined;
}

export function assertCanaryC1Prerequisite(
  spec: LunaCanarySpecV1,
  input: unknown,
  expectedReportHash?: string,
  implementationReceipt?: CanaryImplementationReceiptV2,
): CanaryStageReportV1 {
  const prerequisite = parseCanaryStageReport(input);
  if (prerequisite.stage !== "c0") {
    throw new Error("C1 prerequisite must be a C0 report");
  }
  if (
    prerequisite.spec.canaryId !== spec.canaryId ||
    prerequisite.spec.specHash !== spec.specHash
  ) {
    throw new Error("C1 prerequisite must use the exact same canary spec");
  }
  if (prerequisite.readiness.status !== "ready") {
    throw new Error("C1 prerequisite C0 report is not ready");
  }
  if (
    expectedReportHash !== undefined &&
    prerequisite.reportHash !== expectedReportHash
  ) {
    throw new Error("C1 prerequisite report hash does not match");
  }
  if (implementationReceipt !== undefined) {
    if (prerequisite.implementationReceipt === undefined) {
      throw new Error(
        "Legacy C0 report lacks the implementation receipt required for hardened C1",
      );
    }
    if (
      canonicalJson(
        prerequisite.implementationReceipt as unknown as JsonValue,
      ) !== canonicalJson(implementationReceipt as unknown as JsonValue)
    ) {
      throw new Error("C1 implementation does not match its C0 prerequisite");
    }
  }
  return prerequisite;
}

export async function executeCanaryStage(
  options: ExecuteCanaryStageOptions,
): Promise<CanaryStageReportV1> {
  const spec = parseLunaCanarySpec(options.spec);
  const stageSpec = spec.stages.find((entry) => entry.stage === options.stage);
  if (stageSpec === undefined) throw new Error("Canary stage is not frozen");
  const ledger = new V03CanaryJsonLedger(
    options.cwd,
    options.artifactRoot,
    spec.canaryId,
  );
  await ledger.putSpec(spec);
  const implementationReceipt = parseImplementationReceipt(
    await options.runner.implementationReceipt(spec),
    "runner implementation receipt",
  );
  if (
    spec.schemaVersion !== 2 ||
    spec.implementationReceipt === undefined ||
    canonicalJson(spec.implementationReceipt as unknown as JsonValue) !==
      canonicalJson(implementationReceipt as unknown as JsonValue)
  ) {
    throw new Error(
      "Canary execution requires a V2 spec bound to the exact implementation",
    );
  }
  let prerequisiteReportHash: string | null = null;
  if (options.stage === "c1") {
    if (options.prerequisiteReport === undefined) {
      throw new Error("C1 requires the exact ready C0 report");
    }
    const supplied = assertCanaryC1Prerequisite(
      spec,
      options.prerequisiteReport,
      undefined,
      implementationReceipt,
    );
    const sealed = await ledger.getReport("c0");
    if (sealed === null) {
      throw new Error("C1 requires a sealed C0 report in the same ledger");
    }
    assertCanaryC1Prerequisite(
      spec,
      sealed,
      supplied.reportHash,
      implementationReceipt,
    );
    prerequisiteReportHash = supplied.reportHash;
  } else if (options.prerequisiteReport !== undefined) {
    throw new Error("C0 does not accept a prerequisite report");
  }
  const existing = await ledger.getReport(options.stage);
  if (existing !== null) {
    if (
      existing.implementationReceipt === undefined ||
      canonicalJson(existing.implementationReceipt as unknown as JsonValue) !==
        canonicalJson(implementationReceipt as unknown as JsonValue)
    ) {
      throw new Error("Existing canary report used a different implementation");
    }
    if (
      existing.stage === "c1" &&
      existing.prerequisiteReportHash !== prerequisiteReportHash
    ) {
      throw new Error("Existing C1 report used a different C0 prerequisite");
    }
    return existing;
  }
  if (await ledger.hasStarted(options.stage)) {
    throw new Error(
      "Canary stage was interrupted; no-resume policy requires a new canary identity",
    );
  }
  const modelReceipt = await options.runner.preflight(spec);
  assertModelReceipt(spec, modelReceipt);
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const startedAt = nowIso();
  await ledger.putStarted(options.stage, startedAt);
  const cells: CanaryCellReportV1[] = [];
  for (const arm of stageSpec.arms) {
    let cell: CanaryCellReportV1;
    try {
      cell = buildScoredCell(
        spec,
        options.stage,
        stageSpec.fixture,
        arm,
        await options.runner.runCell({
          spec,
          stage: options.stage,
          fixture: stageSpec.fixture,
          arm,
        }),
      );
    } catch (error) {
      cell = buildFailureCell(
        spec,
        options.stage,
        stageSpec.fixture,
        arm,
        classifyCellError(error),
      );
    }
    await ledger.putCell(cell);
    cells.push(cell);
  }
  const finishedAt = nowIso();
  const basis: ReportHashBasis = {
    schemaVersion: 2,
    spec,
    stage: options.stage,
    stageId: STAGE_IDENTITIES[options.stage].stageId,
    seed: STAGE_IDENTITIES[options.stage].seed,
    armOrder: CANARY_ARMS,
    modelReceipt,
    implementationReceipt,
    startedAt,
    finishedAt,
    prerequisiteReportHash,
    cells,
    readiness: evaluateCanaryReadiness(spec, options.stage, cells),
  };
  const report = parseCanaryStageReport({
    ...basis,
    reportHash: digest(basis),
  });
  await ledger.putReport(report);
  return report;
}

export interface PublishCanaryReportOptions {
  readonly cwd: string;
  readonly artifactRoot: string;
  readonly canaryId: string;
  readonly stage: CanaryStage;
  readonly outputPath: string;
}

export async function publishCanaryReport(
  options: PublishCanaryReportOptions,
): Promise<string> {
  if (isAbsolute(options.outputPath)) {
    throw new Error("Canary publication path must be workspace-relative");
  }
  const output = resolve(options.cwd, options.outputPath);
  if (!isContained(resolve(options.cwd), output)) {
    throw new Error("Canary publication path escapes the workspace");
  }
  const ledger = new V03CanaryJsonLedger(
    options.cwd,
    options.artifactRoot,
    options.canaryId,
  );
  const report = await ledger.getReport(options.stage);
  if (report === null) throw new Error("Canary stage has no sealed report");
  await writeOnce(resolve(options.cwd), output, report);
  return output;
}

export async function readCanarySpec(path: string): Promise<LunaCanarySpecV1> {
  return parseLunaCanarySpec(
    JSON.parse(await readFile(resolve(path), "utf8")) as unknown,
  );
}

export async function readCanaryReport(
  path: string,
): Promise<CanaryStageReportV1> {
  return parseCanaryStageReport(
    JSON.parse(await readFile(resolve(path), "utf8")) as unknown,
  );
}
