import { PiHarnessError } from "@chronorift/pi-harness";
import { describe, expect, it } from "vitest";

import { classifyFormalAttemptError } from "./v03-formal-classifier.js";

describe("classifyFormalAttemptError", () => {
  it.each([
    [408, "http_408"],
    [429, "http_429"],
    [500, "http_5xx"],
    [503, "http_5xx"],
  ] as const)("retries provider status %i", (status, code) => {
    expect(
      classifyFormalAttemptError(new Error(`${status}: provider failed`), {
        progressObserved: false,
      }),
    ).toMatchObject({ status: "infrastructure_failure", code });
  });

  it("never retries a non-retryable provider 4xx", () => {
    expect(
      classifyFormalAttemptError(new Error("400: invalid max_tokens"), {
        progressObserved: false,
      }),
    ).toMatchObject({ status: "invalid", code: "provider_non_retryable_4xx" });
  });

  it("retries a timeout only before progress", () => {
    const error = new PiHarnessError("AGENT_TIMEOUT", "timed out");
    expect(
      classifyFormalAttemptError(error, { progressObserved: false }),
    ).toMatchObject({
      status: "infrastructure_failure",
      code: "no_progress_timeout",
    });
    expect(
      classifyFormalAttemptError(error, { progressObserved: true }),
    ).toMatchObject({
      status: "diagnostic_failure",
      code: "timeout_after_progress",
    });
  });

  it("prefers Pi's session-scoped timeout progress detail", () => {
    const error = new PiHarnessError("AGENT_TIMEOUT", "timed out", {
      details: { progressObserved: true },
    });
    expect(
      classifyFormalAttemptError(error, { progressObserved: false }),
    ).toMatchObject({
      status: "diagnostic_failure",
      code: "timeout_after_progress",
    });
  });

  it("does not let a stale false timeout detail erase observed progress", () => {
    const error = new PiHarnessError("AGENT_TIMEOUT", "timed out", {
      details: { progressObserved: false },
    });
    expect(
      classifyFormalAttemptError(error, { progressObserved: true }),
    ).toMatchObject({ status: "diagnostic_failure" });
  });

  it("does not retry missing or invalid proposals", () => {
    for (const code of [
      "PROPOSAL_MISSING",
      "INVALID_DIAGNOSIS",
      "INVALID_TOOL_FLOW",
    ] as const) {
      expect(
        classifyFormalAttemptError(new PiHarnessError(code, "bad output"), {
          progressObserved: false,
        }),
      ).toMatchObject({ status: "diagnostic_failure" });
    }
  });

  it("does not mistake an argument value for an HTTP status", () => {
    expect(
      classifyFormalAttemptError(
        new PiHarnessError("INVALID_ARGUMENT", "offset 500 exceeds range"),
        { progressObserved: false },
      ),
    ).toMatchObject({ status: "diagnostic_failure" });
  });

  it("retries a connection error wrapped as a missing proposal", () => {
    expect(
      classifyFormalAttemptError(
        new PiHarnessError("PROPOSAL_MISSING", "fetch failed: ECONNRESET"),
        { progressObserved: false },
      ),
    ).toMatchObject({
      status: "infrastructure_failure",
      code: "connection",
    });
  });

  it.each([
    "408: request timed out",
    "429: throttled",
    "503: unavailable",
    "fetch failed: ECONNRESET",
  ])("does not retry provider failures after progress: %s", (message) => {
    expect(
      classifyFormalAttemptError(new Error(message), {
        progressObserved: true,
      }),
    ).toMatchObject({ status: "diagnostic_failure" });
  });

  it("treats configuration and unknown failures as invalid", () => {
    expect(
      classifyFormalAttemptError(
        new PiHarnessError("MODEL_CONFIGURATION", "not max"),
        { progressObserved: false },
      ),
    ).toMatchObject({ status: "invalid" });
    expect(
      classifyFormalAttemptError(new Error("mystery"), {
        progressObserved: false,
      }),
    ).toMatchObject({ status: "invalid", code: "unclassified_failure" });
  });
});
