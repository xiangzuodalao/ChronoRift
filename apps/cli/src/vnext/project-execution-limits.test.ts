import { describe, expect, it } from "vitest";

import { ProjectExecutionLimitsSchema } from "./project-execution-limits.js";
import { AgentExecutionBudget } from "./agent-execution-scope.js";
import { createProjectEnvironmentToolCallAdmissionV1 } from "@chronorift/pi-harness";

describe("Host project execution limits", () => {
  it("preserves historical defaults", () => {
    expect(ProjectExecutionLimitsSchema.parse({})).toEqual({
      sharedToolCallLimit: 256,
      workerTurnTimeoutMs: 600_000,
      workerTurnToolCallLimit: 64,
    });
  });

  it("enforces the same larger execution budget for Single and the whole team", () => {
    const limits = ProjectExecutionLimitsSchema.parse({
      sharedToolCallLimit: 2048,
      workerTurnTimeoutMs: 2_700_000,
      workerTurnToolCallLimit: 512,
    });
    const single = createProjectEnvironmentToolCallAdmissionV1(
      limits.sharedToolCallLimit,
    );
    const team = new AgentExecutionBudget(limits.sharedToolCallLimit);
    for (let index = 0; index < 2048; index += 1) {
      expect(single.tryAdmit("read")).toBe(true);
      team.admit("read");
    }
    expect(single.tryAdmit("read")).toBe(false);
    expect(() => team.admit("read")).toThrow(/budget exhausted/u);
    expect(() => team.admit("game_stop")).not.toThrow();
    expect(single.admitted).toBe(team.used);
  });

  it.each([
    { sharedToolCallLimit: 0 },
    { sharedToolCallLimit: 2049 },
    { sharedToolCallLimit: 1.5 },
    { workerTurnTimeoutMs: 0 },
    { workerTurnTimeoutMs: 3_600_001 },
    { workerTurnTimeoutMs: Number.POSITIVE_INFINITY },
    { workerTurnToolCallLimit: 0 },
    { workerTurnToolCallLimit: 513 },
    { workerTurnToolCallLimit: Number.NaN },
    { unknownBudget: 1 },
  ])("rejects invalid or unknown limits %j", (value) => {
    expect(ProjectExecutionLimitsSchema.safeParse(value).success).toBe(false);
  });
});
