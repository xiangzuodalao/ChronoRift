import { describe, expect, it } from "vitest";

import { PiHarnessError, PiProviderFailureError } from "@chronorift/pi-harness";

import { classifyFormalAttemptErrorV3 } from "./v03-formal-classifier-v3.js";

const noProgress = {
  model: { outputObserved: false },
  tools: { started: 0 },
  game: { diagnosticExecutions: 0 },
  proposalSubmitted: false,
} as const;

const modelProgress = {
  ...noProgress,
  model: { outputObserved: true },
} as const;

const providerFailure = (
  code:
    | "connection"
    | "http_429"
    | "http_5xx"
    | "auth"
    | "provider_error_unknown"
    | "aborted",
  retryClass: "transient" | "permanent" | "unknown",
  status: number | null = null,
): PiProviderFailureError =>
  new PiProviderFailureError("provider failed", {
    phase: "request",
    code,
    httpStatus: status,
    retryClass,
    provider: "openai-codex",
    model: "gpt-5.6-luna",
  });

describe("formal V3 failure classification", () => {
  it("retries typed connection failures only before diagnostic progress", () => {
    expect(
      classifyFormalAttemptErrorV3(
        providerFailure("connection", "transient"),
        noProgress,
      ),
    ).toMatchObject({ kind: "infrastructure", retryable: true });
    expect(
      classifyFormalAttemptErrorV3(
        providerFailure("connection", "transient"),
        modelProgress,
      ),
    ).toMatchObject({ kind: "infrastructure", retryable: false });
  });

  it.each([
    ["http_429", "transient", 429],
    ["http_5xx", "transient", 503],
    ["provider_error_unknown", "unknown", null],
    ["aborted", "unknown", null],
  ] as const)(
    "keeps %s as typed infrastructure",
    (code, retryClass, status) => {
      expect(
        classifyFormalAttemptErrorV3(
          providerFailure(code, retryClass, status),
          noProgress,
        ),
      ).toMatchObject({
        kind: "infrastructure",
        failure: { code, retryClass, httpStatus: status },
      });
    },
  );

  it("does not retry an unknown provider failure before progress", () => {
    expect(
      classifyFormalAttemptErrorV3(
        providerFailure("provider_error_unknown", "unknown"),
        noProgress,
      ),
    ).toMatchObject({ kind: "infrastructure", retryable: false });
  });

  it("treats permanent provider failures as invalid", () => {
    expect(
      classifyFormalAttemptErrorV3(
        providerFailure("auth", "permanent", 401),
        noProgress,
      ),
    ).toMatchObject({ kind: "invalid", code: "auth_failure" });
  });

  it("distinguishes no-progress and progressed harness timeouts", () => {
    const error = new PiHarnessError("AGENT_TIMEOUT", "timed out");
    expect(classifyFormalAttemptErrorV3(error, noProgress)).toMatchObject({
      kind: "infrastructure",
      retryable: true,
    });
    expect(classifyFormalAttemptErrorV3(error, modelProgress)).toMatchObject({
      kind: "diagnostic",
      code: "progress_timeout",
    });
  });

  it("maps normal missing proposals and budgets to diagnostic failures", () => {
    expect(
      classifyFormalAttemptErrorV3(
        new PiHarnessError("PROPOSAL_MISSING", "missing"),
        modelProgress,
      ),
    ).toMatchObject({ kind: "diagnostic", code: "proposal_missing" });
    expect(
      classifyFormalAttemptErrorV3(
        new PiHarnessError("AGENT_BUDGET_EXHAUSTED", "budget"),
        modelProgress,
      ),
    ).toMatchObject({ kind: "diagnostic", code: "budget_exhausted" });
    expect(
      classifyFormalAttemptErrorV3(
        new PiHarnessError(
          "INVALID_DIAGNOSIS",
          "proposal cites an unresolved event",
        ),
        modelProgress,
      ),
    ).toMatchObject({ kind: "diagnostic", code: "invalid_proposal" });
  });
});
