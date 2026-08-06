import type {
  DiagnosisProposalDraftV1,
  InvestigationApiV1,
  InvestigationToolNameV1,
  ResourceHandleV1,
} from "@chronorift/agent-protocol";
import type { DiagnosisProposalV4 } from "@chronorift/domain";

import type {
  PiSessionReference,
  PiThinkingLevel,
  PiUsageStats,
} from "./types.js";

export type V04NonTerminalToolName = Exclude<
  InvestigationToolNameV1,
  "submit_diagnosis_proposal_v4"
>;

export interface V04ScriptObservation {
  readonly sequence: number;
  readonly toolName: V04NonTerminalToolName;
  readonly input: unknown;
  readonly result: unknown;
}

export type V04ScriptValue<T> =
  T | ((observations: readonly V04ScriptObservation[]) => T);

export type V04ScriptInput =
  | Readonly<Record<string, unknown>>
  | ((
      observations: readonly V04ScriptObservation[],
    ) => Readonly<Record<string, unknown>>);

/**
 * One caller-authored, SDK-neutral faux-model action. The adapter deliberately
 * does not interpret results or select a mechanism on the caller's behalf.
 */
export interface ScriptedV04ToolStep {
  readonly toolName: V04NonTerminalToolName;
  readonly input: V04ScriptInput;
}

interface V04PiHarnessBaseOptions {
  readonly cwd: string;
  readonly runDir: string;
  readonly api: InvestigationApiV1;
  readonly initialCapsuleHandle: ResourceHandleV1;
  readonly thinkingLevel?: PiThinkingLevel | undefined;
  readonly timeoutMs?: number | undefined;
  readonly sdkRetry?: boolean | undefined;
  readonly additionalInstructions?: string | undefined;
}

export interface V04PiHarnessOptions extends V04PiHarnessBaseOptions {
  readonly provider: string;
  readonly model: string;
}

export interface ScriptedV04PiHarnessOptions extends V04PiHarnessBaseOptions {
  readonly steps: readonly ScriptedV04ToolStep[];
  readonly finalDraft: V04ScriptValue<DiagnosisProposalDraftV1>;
}

export interface V04PiToolCallRecord {
  readonly sequence: number;
  readonly toolName: InvestigationToolNameV1;
  readonly status: "succeeded" | "failed";
}

export interface V04PiSessionReference extends PiSessionReference {
  readonly stats: PiUsageStats;
  readonly activeTools: readonly InvestigationToolNameV1[];
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

export interface V04PiDiagnosisRunResult {
  readonly proposal: DiagnosisProposalV4;
  readonly piSession: V04PiSessionReference;
  readonly toolCalls: readonly V04PiToolCallRecord[];
  readonly wallTimeMs: number;
}
