import { describe, expect, it } from "vitest";

import { PiHarnessError } from "../src/errors.js";
import { V03SessionGuard } from "../src/internal/v03-session-guard.js";

describe("V03SessionGuard", () => {
  it("allows exactly 12 progressing calls and aborts before call 13", () => {
    let revision = 0;
    let aborts = 0;
    const guard = new V03SessionGuard({
      semanticRevision: () => revision,
      terminalToolViolation: () => undefined,
      requestAbort: () => {
        aborts += 1;
      },
    });

    for (let call = 1; call <= 12; call += 1) {
      guard.onToolExecutionStart(`tool_${call}`);
      revision += 1;
      guard.onToolExecutionEnd(`tool_${call}`, false);
    }
    expect(guard.terminalError).toBeUndefined();
    expect(guard.toolCalls).toBe(12);
    expect(guard.completedToolCalls).toBe(12);

    guard.onToolExecutionStart("tool_13");
    expect(guard.terminalError).toMatchObject({
      code: "AGENT_BUDGET_EXHAUSTED",
      details: { budget: "tool_calls", limit: 12, observed: 13 },
    });
    expect(aborts).toBe(1);
  });

  it("preserves the first tool error and requests abort exactly once", () => {
    let aborts = 0;
    const first = new PiHarnessError("SOURCE_NOT_FOUND", "first tool failure");
    const guard = new V03SessionGuard({
      semanticRevision: () => 0,
      terminalToolViolation: () => first,
      requestAbort: () => {
        aborts += 1;
      },
    });

    guard.onToolExecutionStart("source_read_v1");
    guard.onToolExecutionEnd("source_read_v1", true);
    guard.fail(new PiHarnessError("AGENT_FAILED", "later cleanup failure"));

    expect(guard.terminalError).toBe(first);
    expect(guard.toolErrors).toBe(1);
    expect(guard.completedToolCalls).toBe(1);
    expect(aborts).toBe(1);
  });

  it("rejects the first successful result without semantic progress", () => {
    let aborts = 0;
    const guard = new V03SessionGuard({
      semanticRevision: () => 0,
      terminalToolViolation: () => undefined,
      requestAbort: () => {
        aborts += 1;
      },
    });

    guard.onToolExecutionStart("source_read_v1");
    guard.onToolExecutionEnd("source_read_v1", false);

    expect(guard.terminalError).toMatchObject({
      code: "AGENT_BUDGET_EXHAUSTED",
      details: { budget: "semantic_progress", limit: 0, observed: 1 },
    });
    expect(guard.consecutiveNonProgressToolResults).toBe(1);
    expect(aborts).toBe(1);
  });
});
