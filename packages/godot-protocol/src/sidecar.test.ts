import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  RuntimeSidecarLaunchV1Schema,
  RuntimeSidecarDiagnosticV1Schema,
} from "./sidecar.js";

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const launch = () => ({
  schemaVersion: 1,
  taskId: "task:test",
  buildId: "build:test",
  runtimeId: "runtime:test",
  executionId: "execution:test",
  candidateSourceHash: digest("candidate"),
  fixtureHash: digest("fixture"),
  projectHash: digest("project"),
  addonHash: digest("addon"),
  protocolVersion: 2,
  token: "a".repeat(64),
  fixedFps: 120,
  physicsTicksPerSecond: 60,
  fixtureControls: {},
  startupTimeoutMs: 30_000,
  executionTimeoutMs: 180_000,
  diagnosticFrameMaxBytes: 65_536,
  diagnosticTotalMaxBytes: 1024 * 1024,
  diagnosticMaxCount: 128,
});

describe("runtime sidecar wire contracts", () => {
  it("accepts an exact bounded launch and rejects unknown keys", () => {
    expect(RuntimeSidecarLaunchV1Schema.parse(launch())).toEqual(launch());
    expect(
      RuntimeSidecarLaunchV1Schema.safeParse({ ...launch(), hidden: true })
        .success,
    ).toBe(false);
  });

  it("keeps addon bytes off the wire and strictly bounds diagnostics", () => {
    expect(
      RuntimeSidecarLaunchV1Schema.safeParse({
        ...launch(),
        addonFiles: [],
      }).success,
    ).toBe(false);
    expect(
      RuntimeSidecarLaunchV1Schema.safeParse({
        ...launch(),
        diagnosticFrameMaxBytes: 4096,
        diagnosticTotalMaxBytes: 4096,
      }).success,
    ).toBe(false);
    expect(
      RuntimeSidecarLaunchV1Schema.safeParse({
        ...launch(),
        diagnosticMaxCount: 0,
      }).success,
    ).toBe(false);
  });

  it("accepts 256-byte opaque resource IDs and rejects traversal or longer IDs", () => {
    expect(
      RuntimeSidecarLaunchV1Schema.safeParse({
        ...launch(),
        taskId: `t${"a".repeat(255)}`,
      }).success,
    ).toBe(true);
    expect(
      RuntimeSidecarLaunchV1Schema.safeParse({
        ...launch(),
        runtimeId: "runtime..escape",
      }).success,
    ).toBe(false);
    expect(
      RuntimeSidecarLaunchV1Schema.safeParse({
        ...launch(),
        executionId: `e${"a".repeat(256)}`,
      }).success,
    ).toBe(false);
  });

  it("strictly validates sidecar diagnostics without accepting verdicts", () => {
    expect(
      RuntimeSidecarDiagnosticV1Schema.parse({
        schemaVersion: 1,
        kind: "stage_ready",
        fixtureHash: digest("fixture"),
        projectHash: digest("project"),
        addonHash: digest("addon"),
      }).kind,
    ).toBe("stage_ready");
    expect(
      RuntimeSidecarDiagnosticV1Schema.parse({
        schemaVersion: 1,
        kind: "candidate_process_failure",
        candidateSourceHash: digest("candidate"),
        phase: "before_runtime_connection",
        reason: "nonzero_exit",
        exitCode: 1,
      }).kind,
    ).toBe("candidate_process_failure");
    expect(
      RuntimeSidecarDiagnosticV1Schema.safeParse({
        schemaVersion: 1,
        kind: "sidecar_error",
        code: "ROOT_CAUSE_FOUND",
        message: "no",
      }).success,
    ).toBe(false);
  });
});
