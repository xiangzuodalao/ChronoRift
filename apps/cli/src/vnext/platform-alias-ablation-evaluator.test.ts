import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { PlatformAliasAblationRunV1Schema } from "./platform-alias-demo.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const evaluator = join(
  process.cwd(),
  "scripts/evaluate-platform-alias-ablation.mjs",
);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const platforms = (fixed: boolean) =>
  [
    ["Platforms/Platform", 2],
    ["Platforms/Platform2", 1],
    ["Platforms/Platform3", 3],
    ["Platforms/Platform4", 6],
  ].map(([nodePath, width], index) => ({
    node_path: nodePath,
    configured_width_tiles: width,
    rendered_sprite_count: width,
    solid_collision_width_px: Number(width) * 128,
    area_collision_width_px: fixed ? Number(width) * 128 : 768,
    area_shape_instance_id: fixed ? `shape-${index}` : "shared-shape",
  }));

const stateRows = (fixed: boolean) => [
  {
    schemaVersion: 1,
    rowId: "query-row.fixture",
    kind: "state",
    clock: null,
    value: {
      schemaVersion: 1,
      recordSequence: 1,
      clock: {
        processFrame: 1,
        physicsTick: 1,
        simulationTimeUs: 16_667,
        renderFrame: null,
      },
      kind: "state_sample",
      payload: {
        stateDomainId: "platform_geometry",
        value: { platforms: platforms(fixed) },
        semanticCoverage: "declared",
      },
    },
  },
];

const observation = (name: string, fixed: boolean) => ({
  schemaVersion: 1,
  buildId: `build.${name}`,
  runtimeId: `runtime.${name}`,
  executionId: `execution.${name}`,
  capabilities: {},
  launch: {},
  entities: { rows: [] },
  state: { rows: stateRows(fixed) },
  stop: {},
});

const run = (
  arm: "coding-only" | "chronorift",
  options: { readonly fixed?: boolean; readonly model?: string } = {},
) => {
  const taskId = `task-${arm}`;
  const diff = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n";
  const gameToolCalls =
    arm === "chronorift"
      ? [
          {
            schemaVersion: 1,
            toolCallId: "call.platform-launch",
            toolName: "game_launch",
            input: {
              schemaVersion: 1,
              taskId,
              buildId: "build.agent",
              launchTargetId: "main",
              parameters: {},
            },
            response: {
              schemaVersion: 1,
              toolCallId: "call.platform-launch",
              outcome: "success",
              output: {
                schemaVersion: 1,
                taskId,
                buildId: "build.agent",
                runtimeId: "runtime.agent",
                executionId: "execution.agent",
              },
            },
          },
          {
            schemaVersion: 1,
            toolCallId: "call.platform-state",
            toolName: "game_query",
            input: {
              schemaVersion: 1,
              taskId,
              executionId: "execution.agent",
              select: "state",
              limit: 200,
            },
            response: {
              schemaVersion: 1,
              toolCallId: "call.platform-state",
              outcome: "success",
              output: {
                schemaVersion: 1,
                taskId,
                executionId: "execution.agent",
                rows: stateRows(false),
                nextCursor: null,
                coverage: [],
                loss: [],
                limitations: [],
              },
            },
          },
        ]
      : [];
  const candidate = observation(`${arm}.candidate`, options.fixed !== false);
  const value = {
    schemaVersion: 1,
    arm,
    configuration: {
      schemaVersion: 1,
      provider: "openai-codex",
      model: options.model ?? "gpt-5.6-luna",
      thinkingLevel: "max",
      timeoutMs: 600_000,
      environmentProfile: "coding",
      environmentInstructionProfile: "task-id-v1",
      prompt:
        "A falling platform can activate while the player is still outside its visible width. Investigate the project, make the smallest appropriate fix, and validate the candidate. You choose the investigation, edit, and validation strategy.",
      sourceCommit: "e78b339500dec8e480b33723c4156bf9b74cd25c",
      sourceTree: "9941cb045b3cd73c4554ca1de337a341b383590b",
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
        arm === "chronorift"
          ? ["game_capabilities", "game_launch", "game_stop", "game_query"]
          : [],
    },
    result: {
      schemaVersion: 1,
      commandStatus: "completed",
      taskId,
      source: {
        schemaVersion: 1,
        repositoryRoot: "/tmp/source",
        commit: "e78b339500dec8e480b33723c4156bf9b74cd25c",
        tree: "9941cb045b3cd73c4554ca1de337a341b383590b",
        selectedTreeSha256: "0".repeat(64),
        checkoutCleanBefore: true,
        checkoutCleanAfter: true,
      },
      baselineObservation: observation(`${arm}.baseline`, false),
      workspaceDirectory: `/tmp/workspace-${arm}`,
      taskDirectory: `/tmp/task-${arm}`,
      agent: {
        schemaVersion: 1,
        status: "completed",
        sessionId: `session-${arm}`,
        sessionFile: `/tmp/session-${arm}.jsonl`,
        provider: "openai-codex",
        model: options.model ?? "gpt-5.6-luna",
        requestedThinkingLevel: "max",
        realizedThinkingLevel: "max",
        activeTools: [
          "read",
          "bash",
          "edit",
          "write",
          "grep",
          "find",
          "ls",
          "godot_run",
          ...(arm === "chronorift"
            ? ["game_capabilities", "game_launch", "game_stop", "game_query"]
            : []),
        ],
        assistantText: "done",
        errorMessage: null,
        eventsObserved: 1,
        stats: {
          userMessages: 1,
          assistantMessages: 1,
          toolCalls: gameToolCalls.length,
          toolResults: gameToolCalls.length,
          totalMessages: 2 + gameToolCalls.length * 2,
          tokens: {
            input: 10,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            total: 20,
          },
          cost: 0,
        },
        gameToolCalls,
      },
      candidatePatch: {
        schemaVersion: 1,
        sha256: createHash("sha256").update(diff).digest("hex"),
        byteLength: Buffer.byteLength(diff),
        unifiedDiff: diff,
      },
      candidateObservation: candidate,
      candidateObservationError: null,
      cleanupReceipt: {
        processGroupTerminated: true,
        cgroupPopulated: false,
        termSent: true,
        killSent: false,
        scopeRemoved: true,
        storageReconciled: true,
      },
      securityEvents: [],
      limitations: ["single pair"],
    },
    candidateRuntimeErrors: { schemaVersion: 1, rows: [] },
    candidateRuntimeErrorsError: null,
    rawGodotToolCalls: [],
  };
  if (options.model === undefined || options.model === "gpt-5.6-luna") {
    expect(PlatformAliasAblationRunV1Schema.parse(value)).toEqual(value);
  }
  return value;
};

const execute = async (control: unknown, treatment: unknown) => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-ablation-eval-"));
  roots.push(root);
  const controlPath = join(root, "control.json");
  const treatmentPath = join(root, "treatment.json");
  await Promise.all([
    writeFile(controlPath, JSON.stringify(control)),
    writeFile(treatmentPath, JSON.stringify(treatment)),
  ]);
  return execFileAsync(process.execPath, [
    evaluator,
    controlPath,
    treatmentPath,
  ]);
};

describe("platform-alias ablation evaluator", () => {
  it("reports both case-level oracle outcomes without selecting a winner", async () => {
    const completed = await execute(
      run("coding-only", { fixed: false }),
      run("chronorift", { fixed: true }),
    );
    const result = JSON.parse(completed.stdout) as {
      readonly configurationMatched: boolean;
      readonly arms: {
        readonly codingOnly: { readonly oraclePassed: boolean };
        readonly chronorift: { readonly oraclePassed: boolean };
      };
      readonly winner?: unknown;
    };
    expect(result.configurationMatched).toBe(true);
    expect(result.arms.codingOnly.oraclePassed).toBe(false);
    expect(result.arms.chronorift.oraclePassed).toBe(true);
    expect(result).not.toHaveProperty("winner");
  });

  it("rejects a model mismatch before interpreting the pair", async () => {
    await expect(
      execute(run("coding-only"), run("chronorift", { model: "gpt-5.6-sol" })),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("rejects malformed input instead of inventing a missing observation", async () => {
    await expect(execute({}, run("chronorift"))).rejects.toMatchObject({
      code: 1,
    });
  });

  it("rejects a tampered patch binding before reporting an outcome", async () => {
    const control = structuredClone(run("coding-only"));
    control.result.candidatePatch.sha256 = "f".repeat(64);

    await expect(execute(control, run("chronorift"))).rejects.toMatchObject({
      code: 1,
    });
  });

  it("rejects a successful semantic query without recorded launch lineage", async () => {
    const treatment = structuredClone(run("chronorift"));
    treatment.result.agent.gameToolCalls.shift();

    await expect(execute(run("coding-only"), treatment)).rejects.toMatchObject({
      code: 1,
    });
  });

  it("rejects a semantic query whose execution binding was tampered", async () => {
    const treatment = structuredClone(run("chronorift"));
    const query = treatment.result.agent.gameToolCalls[1];
    if (query?.toolName !== "game_query") throw new Error("missing query call");
    query.input.executionId = "execution.tampered";

    await expect(execute(run("coding-only"), treatment)).rejects.toMatchObject({
      code: 1,
    });
  });

  it("rejects a semantic query recorded before its claimed launch", async () => {
    const treatment = structuredClone(run("chronorift"));
    treatment.result.agent.gameToolCalls.reverse();

    await expect(execute(run("coding-only"), treatment)).rejects.toMatchObject({
      code: 1,
    });
  });
});
