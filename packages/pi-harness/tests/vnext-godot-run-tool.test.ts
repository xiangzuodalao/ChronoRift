import { describe, expect, it, vi } from "vitest";
import { Check } from "typebox/value";

import {
  createProjectEnvironmentToolCallAdmissionV1,
  createVNextGodotRunToolDefinitionV1,
  ProjectEnvironmentToolCallBudgetExhaustedErrorV1,
  VNextGodotRunResultV1Schema,
  VNextGodotRunToolInputV1Schema,
  type VNextGodotRunResultV1,
} from "../src/index.js";

const digest = "a".repeat(64);
const success = (): VNextGodotRunResultV1 => ({
  schemaVersion: 1,
  outcome: "success",
  build: {
    buildId: "build:fixture",
    sourceClosureId: "source:fixture",
    candidateSourceHash: digest,
  },
  receipt: {
    sandboxStatus: "succeeded",
    sandboxExitCode: 0,
    sandboxSignal: null,
    elapsedMonotonicMs: 2_100,
    sourceIdentityReverified: true,
    import: null,
    vanilla: null,
  },
  capture: {
    stdout: "game output\n",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  },
});

describe("vNext shared Godot run tool", () => {
  it("registers one neutral, sequential, strict-input tool", () => {
    const tool = createVNextGodotRunToolDefinitionV1({
      run: () => Promise.resolve(success()),
    });

    expect(tool.name).toBe("godot_run");
    expect(tool.promptSnippet).toBe("Run the project with headless Godot");
    expect(tool.promptGuidelines).toBeUndefined();
    expect(tool.executionMode).toBe("sequential");
    expect(Check(VNextGodotRunToolInputV1Schema, {})).toBe(true);
    expect(Check(VNextGodotRunToolInputV1Schema, { path: "/host" })).toBe(
      false,
    );
  });

  it("validates the port result and records the exact call", async () => {
    const result = success();
    const onCall = vi.fn();
    const tool = createVNextGodotRunToolDefinitionV1(
      { run: () => Promise.resolve(result) },
      { onCall },
    );

    const response = await tool.execute(
      "call_fixture",
      {},
      undefined,
      undefined,
      {} as never,
    );

    const block = response.content[0];
    if (block?.type !== "text") throw new Error("missing text tool result");
    expect(JSON.parse(block.text)).toEqual(result);
    expect(response.details).toEqual(result);
    expect(onCall).toHaveBeenCalledOnce();
    expect(onCall).toHaveBeenCalledWith({
      schemaVersion: 1,
      toolCallId: "call_fixture",
      result,
    });
  });

  it("shares the turn admission budget with coding and game tools", async () => {
    const admission = createProjectEnvironmentToolCallAdmissionV1(1);
    const run = vi.fn(() => Promise.resolve(success()));
    const tool = createVNextGodotRunToolDefinitionV1(
      { run },
      { toolCallAdmission: admission },
    );

    await tool.execute("call_one", {}, undefined, undefined, {} as never);
    await expect(
      tool.execute("call_two", {}, undefined, undefined, {} as never),
    ).rejects.toBeInstanceOf(ProjectEnvironmentToolCallBudgetExhaustedErrorV1);
    expect(run).toHaveBeenCalledOnce();
    expect(admission).toMatchObject({ admitted: 1, rejected: 1 });
  });

  it("rejects malformed or semantic adapter-shaped port output", async () => {
    const onCall = vi.fn();
    const tool = createVNextGodotRunToolDefinitionV1(
      {
        run: () =>
          Promise.resolve({
            ...success(),
            platform_geometry: { areaShapeIds: [42] },
          }),
      },
      { onCall },
    );

    await expect(
      tool.execute("call_fixture", {}, undefined, undefined, {} as never),
    ).rejects.toThrow("Invalid godot_run port result");
    expect(onCall).not.toHaveBeenCalled();
  });

  it("accepts a bounded structured denial without inventing a receipt", () => {
    expect(
      Check(VNextGodotRunResultV1Schema, {
        schemaVersion: 1,
        outcome: "error",
        error: {
          code: "denied",
          message: "sandbox denied the operation",
          recoverable: false,
        },
        build: {
          buildId: "build:fixture",
          sourceClosureId: "source:fixture",
          candidateSourceHash: digest,
        },
      }),
    ).toBe(true);
  });
});
