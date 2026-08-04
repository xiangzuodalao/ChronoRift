import { PiHarnessError } from "@chronorift/pi-harness";

type FormalAttemptOutcome =
  | {
      readonly status: "infrastructure_failure";
      readonly code:
        | "no_progress_timeout"
        | "connection"
        | "http_408"
        | "http_429"
        | "http_5xx";
      readonly message: string;
    }
  | {
      readonly status: "diagnostic_failure";
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly status: "invalid";
      readonly code: string;
      readonly message: string;
    };

export interface ClassifyFormalAttemptErrorOptions {
  readonly progressObserved: boolean;
}

const providerStatus = (message: string): number | null => {
  const matched =
    /^\s*(?:(?:HTTP(?:\/[0-9.]+)?)[ \t]+)?([45]\d\d)(?::|[ \t]|$)/iu.exec(
      message,
    );
  const value = matched?.[1];
  return value === undefined ? null : Number(value);
};

const diagnostic = (code: string, message: string): FormalAttemptOutcome => ({
  status: "diagnostic_failure",
  code,
  message,
});

const invalid = (code: string, message: string): FormalAttemptOutcome => ({
  status: "invalid",
  code,
  message,
});

const infrastructure = (
  code:
    "no_progress_timeout" | "connection" | "http_408" | "http_429" | "http_5xx",
  message: string,
): FormalAttemptOutcome => ({
  status: "infrastructure_failure",
  code,
  message,
});

/**
 * The formal runner retries only failures that this closed classifier marks as
 * infrastructure. Unknown errors are invalid benchmark state, never retries.
 */
export function classifyFormalAttemptError(
  error: unknown,
  options: ClassifyFormalAttemptErrorOptions,
): FormalAttemptOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const status = providerStatus(message);
  if (status === 408) {
    return options.progressObserved
      ? diagnostic("provider_failure_after_progress", message)
      : infrastructure("http_408", message);
  }
  if (status === 429) {
    return options.progressObserved
      ? diagnostic("provider_failure_after_progress", message)
      : infrastructure("http_429", message);
  }
  if (status !== null && status >= 500) {
    return options.progressObserved
      ? diagnostic("provider_failure_after_progress", message)
      : infrastructure("http_5xx", message);
  }
  if (status !== null && status >= 400) {
    return invalid("provider_non_retryable_4xx", message);
  }
  if (
    /\b(?:ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|socket hang up|fetch failed|connection reset)\b/iu.test(
      message,
    )
  ) {
    return options.progressObserved
      ? diagnostic("provider_failure_after_progress", message)
      : infrastructure("connection", message);
  }

  if (error instanceof PiHarnessError) {
    switch (error.code) {
      case "AGENT_TIMEOUT": {
        const recordedProgress = error.details?.["progressObserved"];
        const progressObserved =
          recordedProgress === true || options.progressObserved;
        return progressObserved
          ? diagnostic("timeout_after_progress", message)
          : infrastructure("no_progress_timeout", message);
      }
      case "PROPOSAL_MISSING":
      case "INVALID_DIAGNOSIS":
      case "INVALID_TOOL_FLOW":
      case "INVALID_ARGUMENT":
      case "SOURCE_NOT_FOUND":
      case "SOURCE_NOT_TEXT":
      case "SOURCE_OUT_OF_BOUNDS":
        return diagnostic(error.code.toLocaleLowerCase("en-US"), message);
      case "AUTH_FAILED":
      case "MODEL_NOT_FOUND":
      case "MODEL_UNAVAILABLE":
      case "MODEL_CONFIGURATION":
      case "INVALID_GAME_RESULT":
        return invalid(error.code.toLocaleLowerCase("en-US"), message);
      case "AGENT_FAILED":
        break;
    }
  }

  return invalid("unclassified_failure", message);
}
