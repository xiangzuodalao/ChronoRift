import {
  PiHarnessError,
  PiProviderFailureError,
  type PiProviderFailureCode,
  type PiProviderRetryClass,
} from "@chronorift/pi-harness";

export interface FormalDiagnosticProgressV3 {
  readonly model: { readonly outputObserved: boolean };
  readonly tools: { readonly started: number };
  readonly game: { readonly diagnosticExecutions: number };
  readonly proposalSubmitted: boolean;
}

export interface FormalProviderFailureV3 {
  readonly phase: "request" | "response_stream";
  readonly code: PiProviderFailureCode;
  readonly httpStatus: number | null;
  readonly retryClass: PiProviderRetryClass;
}

export type FormalAttemptFailureV3 =
  | {
      readonly kind: "infrastructure";
      readonly failure:
        | FormalProviderFailureV3
        | {
            readonly code: "no_progress_timeout";
            readonly httpStatus: null;
            readonly retryClass: "transient";
          };
      readonly retryable: boolean;
      readonly message: string;
    }
  | {
      readonly kind: "diagnostic";
      readonly code:
        | "progress_timeout"
        | "proposal_missing"
        | "invalid_proposal"
        | "invalid_tool_flow"
        | "budget_exhausted";
      readonly message: string;
    }
  | {
      readonly kind: "invalid";
      readonly code:
        | "auth_failure"
        | "model_incompatible"
        | "non_retryable_http_4xx"
        | "harness_failure"
        | "godot_failure"
        | "schema_failure";
      readonly message: string;
    };

export const hasFormalDiagnosticProgressV3 = (
  progress: FormalDiagnosticProgressV3,
): boolean =>
  progress.model.outputObserved ||
  progress.tools.started > 0 ||
  progress.game.diagnosticExecutions > 0 ||
  progress.proposalSubmitted;

const invalidProviderCode = (
  error: PiProviderFailureError,
): Extract<FormalAttemptFailureV3, { readonly kind: "invalid" }>["code"] => {
  if (error.code === "auth") return "auth_failure";
  if (error.code === "model_not_found") return "model_incompatible";
  if (error.code === "non_retryable_4xx") return "non_retryable_http_4xx";
  return "harness_failure";
};

/**
 * Closed V3 classifier. Provider message parsing belongs to pi-harness; this
 * boundary consumes only typed failures and monotonic progress.
 */
export function classifyFormalAttemptErrorV3(
  error: unknown,
  progress: FormalDiagnosticProgressV3,
): FormalAttemptFailureV3 {
  const message = error instanceof Error ? error.message : String(error);
  const progressed = hasFormalDiagnosticProgressV3(progress);

  if (error instanceof PiProviderFailureError) {
    if (error.retryClass === "permanent") {
      return {
        kind: "invalid",
        code: invalidProviderCode(error),
        message,
      };
    }
    return {
      kind: "infrastructure",
      failure: {
        phase: error.phase,
        code: error.code,
        httpStatus: error.httpStatus,
        retryClass: error.retryClass,
      },
      retryable: !progressed && error.retryClass === "transient",
      message,
    };
  }

  if (error instanceof PiHarnessError) {
    switch (error.code) {
      case "AGENT_TIMEOUT":
        return progressed
          ? { kind: "diagnostic", code: "progress_timeout", message }
          : {
              kind: "infrastructure",
              failure: {
                code: "no_progress_timeout",
                httpStatus: null,
                retryClass: "transient",
              },
              retryable: true,
              message,
            };
      case "AGENT_BUDGET_EXHAUSTED":
        return { kind: "diagnostic", code: "budget_exhausted", message };
      case "PROPOSAL_MISSING":
        return { kind: "diagnostic", code: "proposal_missing", message };
      case "INVALID_DIAGNOSIS":
        return { kind: "diagnostic", code: "invalid_proposal", message };
      case "INVALID_TOOL_FLOW":
      case "INVALID_ARGUMENT":
      case "SOURCE_NOT_FOUND":
      case "SOURCE_NOT_TEXT":
      case "SOURCE_OUT_OF_BOUNDS":
        return { kind: "diagnostic", code: "invalid_tool_flow", message };
      case "AUTH_FAILED":
        return { kind: "invalid", code: "auth_failure", message };
      case "MODEL_NOT_FOUND":
      case "MODEL_UNAVAILABLE":
      case "MODEL_CONFIGURATION":
        return { kind: "invalid", code: "model_incompatible", message };
      case "INVALID_GAME_RESULT":
        return { kind: "invalid", code: "godot_failure", message };
      case "AGENT_FAILED":
        return { kind: "invalid", code: "harness_failure", message };
    }
  }

  return { kind: "invalid", code: "harness_failure", message };
}
