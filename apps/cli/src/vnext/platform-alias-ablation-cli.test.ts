import { afterEach, describe, expect, it, vi } from "vitest";

const runAblation = vi.hoisted(() => vi.fn());

vi.mock("./platform-alias-demo.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runPlatformAliasAblationV1: runAblation,
}));

import { main } from "../main.js";

afterEach(() => {
  vi.restoreAllMocks();
  runAblation.mockReset();
  process.exitCode = undefined;
});

describe("GN-1 platform alias ablation CLI", () => {
  it("forwards one explicit arm with Luna/max defaults", async () => {
    runAblation.mockResolvedValue({
      schemaVersion: 1,
      arm: "coding-only",
      result: {
        commandStatus: "completed",
        agent: { status: "completed" },
      },
    });
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await main([
      "demo-platform-alias-ablation",
      "--arm",
      "coding-only",
      "--project",
      "/tmp/project",
      "--provider",
      "openai-codex",
      "--model",
      "gpt-5.6-luna",
      "--host-config",
      "/tmp/host.json",
      "--json",
    ]);

    expect(runAblation).toHaveBeenCalledWith({
      arm: "coding-only",
      projectPath: "/tmp/project",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      thinkingLevel: "max",
      hostConfigPath: "/tmp/host.json",
    });
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining('"arm": "coding-only"'),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("rejects an unsupported arm before running Host state", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await main([
      "demo-platform-alias-ablation",
      "--arm",
      "placebo",
      "--project",
      "/tmp/project",
      "--provider",
      "openai-codex",
      "--model",
      "gpt-5.6-luna",
      "--json",
    ]);

    expect(runAblation).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining('"commandStatus": "failed"'),
    );
    expect(process.exitCode).toBe(1);
  });

  it("rejects duplicate singleton flags", async () => {
    await expect(
      main([
        "demo-platform-alias-ablation",
        "--arm",
        "coding-only",
        "--arm",
        "chronorift",
        "--project",
        "/tmp/project",
        "--provider",
        "openai-codex",
        "--model",
        "gpt-5.6-luna",
      ]),
    ).rejects.toThrow(/Duplicate --arm/u);
    expect(runAblation).not.toHaveBeenCalled();
  });
});
