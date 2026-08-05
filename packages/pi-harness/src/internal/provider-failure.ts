import {
  PiProviderFailureError,
  type PiProviderFailureCode,
  type PiProviderFailurePhase,
  type PiProviderRetryClass,
} from "../errors.js";

export interface PiProviderFailureContext {
  readonly message: string;
  readonly phase: PiProviderFailurePhase;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly stopReason?: "error" | "aborted" | undefined;
  readonly cause?: unknown;
}

interface ProviderFailureClassification {
  readonly code: PiProviderFailureCode;
  readonly httpStatus: number | null;
  readonly retryClass: PiProviderRetryClass;
}

const statusPatterns = [
  /^\s*([45]\d\d)(?=\s*[:\-])/u,
  /\bhttp(?:\/\d(?:\.\d)?)?\s+([45]\d\d)\b/iu,
  /\bstatus(?:\s+code)?\s*[:=]?\s*([45]\d\d)\b/iu,
  /["']?(?:httpStatus|statusCode|status)["']?\s*[:=]\s*([45]\d\d)\b/iu,
] as const;

const httpStatusFromMessage = (message: string): number | null => {
  for (const pattern of statusPatterns) {
    const match = pattern.exec(message);
    const status = Number(match?.[1]);
    if (Number.isInteger(status) && status >= 400 && status <= 599) {
      return status;
    }
  }
  return null;
};

const classifyProviderFailure = (
  message: string,
  stopReason: "error" | "aborted" | undefined,
): ProviderFailureClassification => {
  const httpStatus = httpStatusFromMessage(message);
  if (stopReason === "aborted" || /\babort(?:ed|ing)?\b/iu.test(message)) {
    return { code: "aborted", httpStatus, retryClass: "unknown" };
  }
  if (httpStatus === 408) {
    return { code: "http_408", httpStatus, retryClass: "transient" };
  }
  if (httpStatus === 429) {
    return { code: "http_429", httpStatus, retryClass: "transient" };
  }
  if (httpStatus !== null && httpStatus >= 500) {
    return { code: "http_5xx", httpStatus, retryClass: "transient" };
  }
  if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    /\b(?:unauthori[sz]ed|forbidden|authenticat(?:e|ed|ion)|credential(?:s)?|api[ _-]?key)\b/iu.test(
      message,
    )
  ) {
    return { code: "auth", httpStatus, retryClass: "permanent" };
  }
  if (
    /\b(?:model|deployment)\b.{0,80}\b(?:not found|does not exist|unknown|unavailable)\b/isu.test(
      message,
    ) ||
    /\b(?:not found|unknown)\b.{0,80}\b(?:model|deployment)\b/isu.test(message)
  ) {
    return { code: "model_not_found", httpStatus, retryClass: "permanent" };
  }
  if (httpStatus !== null && httpStatus >= 400) {
    return {
      code: "non_retryable_4xx",
      httpStatus,
      retryClass: "permanent",
    };
  }
  if (/\b(?:timeout|timed out|etimedout)\b/iu.test(message)) {
    return { code: "timeout", httpStatus, retryClass: "transient" };
  }
  if (
    /\b(?:connection error|network error|fetch failed|socket hang up|econnreset|econnrefused|enotfound|eai_again)\b/iu.test(
      message,
    )
  ) {
    return { code: "connection", httpStatus, retryClass: "transient" };
  }
  return {
    code: "provider_error_unknown",
    httpStatus,
    retryClass: "unknown",
  };
};

export const createPiProviderFailureError = (
  context: PiProviderFailureContext,
): PiProviderFailureError => {
  const classification = classifyProviderFailure(
    context.message,
    context.stopReason,
  );
  return new PiProviderFailureError(context.message, {
    phase: context.phase,
    code: classification.code,
    httpStatus: classification.httpStatus,
    retryClass: classification.retryClass,
    provider: context.provider,
    model: context.model,
    ...(context.cause === undefined ? {} : { cause: context.cause }),
  });
};
