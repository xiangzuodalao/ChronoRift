import { afterEach, describe, expect, it, vi } from "vitest";

const runAblation = vi.hoisted(() => vi.fn());

vi.mock("./mob-orientation-ablation.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runMobOrientationAblationV1: runAblation,
}));

import { main } from "../main.js";

afterEach(() => {
  vi.restoreAllMocks();
  runAblation.mockReset();
  process.exitCode = undefined;
});

describe("Godot demo Mob orientation ablation CLI", () => {
  it("forwards exactly one frozen-style fresh arm", async () => {
    runAblation.mockResolvedValue({
      schemaVersion: 1,
      arm: "chronorift-v2",
      runIntegrity: "valid",
    });
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await main([
      "demo-mob-orientation-ablation",
      "--arm",
      "chronorift-v2",
      "--project",
      "/tmp/godot-demo-projects/3d/squash_the_creeps",
      "--provider",
      "openai-codex",
      "--model",
      "gpt-5.6-luna",
      "--host-config",
      "/tmp/host.json",
      "--json",
    ]);

    expect(runAblation).toHaveBeenCalledWith({
      arm: "chronorift-v2",
      projectPath: "/tmp/godot-demo-projects/3d/squash_the_creeps",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      thinkingLevel: "max",
      hostConfigPath: "/tmp/host.json",
    });
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining('"arm": "chronorift-v2"'),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("rejects unsupported and duplicate arms before touching Host state", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await main([
      "demo-mob-orientation-ablation",
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

    process.exitCode = undefined;
    await expect(
      main([
        "demo-mob-orientation-ablation",
        "--arm",
        "coding-only",
        "--arm",
        "chronorift-v2",
      ]),
    ).rejects.toThrow(/Duplicate --arm/u);
  });
});
