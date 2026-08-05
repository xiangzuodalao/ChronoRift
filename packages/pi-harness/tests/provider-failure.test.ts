import { describe, expect, it } from "vitest";

import { PiProviderFailureError } from "../src/errors.js";
import { createPiProviderFailureError } from "../src/internal/provider-failure.js";

describe("Pi provider failure classification", () => {
  it.each([
    ["Connection error.", "connection", null, "transient"],
    ["Request timed out", "timeout", null, "transient"],
    ["HTTP 408: request timeout", "http_408", 408, "transient"],
    ["429: rate limited", "http_429", 429, "transient"],
    ["status code 503 from upstream", "http_5xx", 503, "transient"],
    ["401: unauthorized API key", "auth", 401, "permanent"],
    ["404: model glm-x not found", "model_not_found", 404, "permanent"],
    ["400: invalid max_tokens", "non_retryable_4xx", 400, "permanent"],
    ["opaque provider failure", "provider_error_unknown", null, "unknown"],
  ] as const)("classifies %s", (message, code, httpStatus, retryClass) => {
    const error = createPiProviderFailureError({
      message,
      phase: "request",
      provider: "provider",
      model: "model",
      stopReason: "error",
    });

    expect(error).toBeInstanceOf(PiProviderFailureError);
    expect(error).toMatchObject({
      phase: "request",
      code,
      httpStatus,
      retryClass,
      provider: "provider",
      model: "model",
    });
  });

  it("classifies an explicit abort independently of message text", () => {
    const error = createPiProviderFailureError({
      message: "operation stopped",
      phase: "response_stream",
      stopReason: "aborted",
    });

    expect(error).toMatchObject({
      phase: "response_stream",
      code: "aborted",
      httpStatus: null,
      retryClass: "unknown",
    });
  });
});
