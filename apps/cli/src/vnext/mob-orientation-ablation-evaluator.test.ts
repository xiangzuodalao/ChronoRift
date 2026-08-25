import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const arm = (name: "coding-only" | "chronorift-v2") => ({
  schemaVersion: 1,
  arm: name,
  taskId: `task-${name}`,
  runIntegrity: "valid",
  cleanupComplete: true,
  source: { checkoutCleanAfter: true },
  initialBuildId: "build:parent",
  configuration: {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    thinkingLevel: "max",
    timeoutMs: 600_000,
    toolCallBudget: 128,
    prompt: "neutral",
    sourceCommit: "a".repeat(40),
    sourceTree: "b".repeat(40),
    projectPrefix: "3d/squash_the_creeps",
    adapterSha256: "c".repeat(64),
    sharedToolNames: [
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      "godot_run",
    ],
    chronoriftToolNames:
      name === "chronorift-v2"
        ? ["game_capabilities", "game_launch", "game_stop", "game_query"]
        : [],
  },
  candidatePatch: { unifiedDiff: "diff --git a/Mob.gd b/Mob.gd\n" },
  toolCallBudget: { limit: 128, admitted: 4, rejected: 0 },
  evaluator: {
    evaluatorAccepted: name === "chronorift-v2",
    results: [1, 2, 3].map(() => ({ accepted: name === "chronorift-v2" })),
  },
  gameToolCalls:
    name === "chronorift-v2"
      ? [
          {
            request: {
              toolName: "game_launch",
              input: { buildId: "build:parent" },
            },
            response: {
              outcome: "success",
              output: {
                buildId: "build:parent",
                executionId: "execution:parent",
              },
            },
          },
          {
            request: {
              toolName: "game_query",
              input: { executionId: "execution:parent" },
            },
            response: {
              outcome: "success",
              output: {
                stateDomainId: "mob_spawn_orientation",
                up_alignment: 0.91,
              },
            },
          },
        ]
      : [],
  candidateObservation:
    name === "chronorift-v2"
      ? {
          buildId: "build:candidate",
          state: {
            up_alignment: 1,
            velocity_y: 0,
            horizontal_speed: 14,
          },
        }
      : null,
});

const evaluate = async (codingPath: string, treatmentPath: string) => {
  const child = spawn(
    process.execPath,
    [
      "scripts/evaluate-mob-orientation-ablation.mjs",
      codingPath,
      treatmentPath,
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  const stdout: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const result = JSON.parse(Buffer.concat(stdout).toString("utf8")) as unknown;
  return {
    code,
    result: result as {
      readonly heroPromoted: boolean;
      readonly outcome: string;
      readonly failures: readonly string[];
    },
  };
};

describe("Mob orientation pair evaluator", () => {
  it("promotes only a matched treatment win with initial-Build runtime use", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-mob-pair-"));
    roots.push(root);
    const codingPath = join(root, "coding.json");
    const treatmentPath = join(root, "treatment.json");
    await Promise.all([
      writeFile(codingPath, JSON.stringify(arm("coding-only"))),
      writeFile(treatmentPath, JSON.stringify(arm("chronorift-v2"))),
    ]);
    const accepted = await evaluate(codingPath, treatmentPath);
    expect(accepted).toMatchObject({
      code: 0,
      result: { heroPromoted: true, outcome: "treatment_win" },
    });

    const invalidTreatment = arm("chronorift-v2");
    invalidTreatment.gameToolCalls = [];
    await writeFile(treatmentPath, JSON.stringify(invalidTreatment));
    const rejected = await evaluate(codingPath, treatmentPath);
    expect(rejected.code).toBe(1);
    expect(rejected.result).toMatchObject({ heroPromoted: false });
    expect(rejected.result.failures).toContain(
      "treatment did not query Mob state from the exact initial Build before mutation",
    );
  });
});
