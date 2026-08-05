export type PiHarnessErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_GAME_RESULT"
  | "INVALID_TOOL_FLOW"
  | "INVALID_DIAGNOSIS"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_NOT_TEXT"
  | "SOURCE_OUT_OF_BOUNDS"
  | "MODEL_NOT_FOUND"
  | "MODEL_UNAVAILABLE"
  | "MODEL_CONFIGURATION"
  | "AUTH_FAILED"
  | "AGENT_TIMEOUT"
  | "AGENT_FAILED"
  | "AGENT_BUDGET_EXHAUSTED"
  | "PROPOSAL_MISSING";

export class PiHarnessError extends Error {
  readonly code: PiHarnessErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: PiHarnessErrorCode,
    message: string,
    options?: ErrorOptions & {
      readonly details?: Readonly<Record<string, unknown>> | undefined;
    },
  ) {
    super(message, options);
    this.name = "PiHarnessError";
    this.code = code;
    this.details = options?.details;
  }
}

export type PiProviderFailurePhase = "request" | "response_stream";

export type PiProviderFailureCode =
  | "connection"
  | "timeout"
  | "http_408"
  | "http_429"
  | "http_5xx"
  | "auth"
  | "model_not_found"
  | "non_retryable_4xx"
  | "provider_error_unknown"
  | "aborted";

export type PiProviderRetryClass = "transient" | "permanent" | "unknown";

export interface PiProviderFailureOptions extends ErrorOptions {
  readonly phase: PiProviderFailurePhase;
  readonly code: PiProviderFailureCode;
  readonly httpStatus?: number | null | undefined;
  readonly retryClass: PiProviderRetryClass;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
}

/**
 * Structured provider terminal state. It is intentionally distinct from a
 * PiHarnessError so proposal, tool-flow, and provider failures cannot collapse.
 */
export class PiProviderFailureError extends Error {
  public readonly phase: PiProviderFailurePhase;
  public readonly code: PiProviderFailureCode;
  public readonly httpStatus: number | null;
  public readonly retryClass: PiProviderRetryClass;
  public readonly provider: string | undefined;
  public readonly model: string | undefined;

  public constructor(message: string, options: PiProviderFailureOptions) {
    super(message, options);
    this.name = "PiProviderFailureError";
    this.phase = options.phase;
    this.code = options.code;
    this.httpStatus = options.httpStatus ?? null;
    this.retryClass = options.retryClass;
    this.provider = options.provider;
    this.model = options.model;
  }
}
