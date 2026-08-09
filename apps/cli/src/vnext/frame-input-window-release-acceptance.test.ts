import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JsonValueSchema,
  TaskPatchIdentityV1Schema,
  VNextBuildV1Schema,
  VNextExecutionRecordV1Schema,
  VNextRawRuntimeEventV1Schema,
  asSha256DigestV1,
  asTaskId,
} from "@chronorift/domain";
import {
  VNextRuntimeStore,
  VNextTaskStore,
  contentHash,
} from "@chronorift/json-artifacts";
import { describe, expect, it } from "vitest";

import {
  FrameInputWindowCandidateExecutionError,
  collectM3LiveTaskEvidenceV1,
  createM3LiveAcceptanceSummaryV1,
  createFrameInputWindowAcceptanceMatrixV1,
  planM3LiveAcceptanceAttemptV1,
  runM3BoundedEvaluatorOnlyAcceptanceV1,
  runFrameInputWindowReleaseAcceptanceV1,
  type FrameInputWindowObservationV1,
  type FrameInputWindowScenarioRunnerV1,
  type FrameInputWindowScenarioV1,
} from "./frame-input-window-release-acceptance.js";
import {
  VNextAgentTaskV2Schema,
  VNextAgentTurnV1Schema,
} from "./task-agent-contracts.js";
import { createTaskDirectoryLayout } from "./task-paths.js";

const baselineSourceHash = asSha256DigestV1("a".repeat(64));
const candidateSourceHash = asSha256DigestV1("b".repeat(64));
const taskEvidence = {
  schemaVersion: 1 as const,
  provider: "openai-codex" as const,
  model: "gpt-5.6-luna" as const,
  thinkingLevel: "max" as const,
  loopStatus: "completed" as const,
  finalCandidateSourceHash: candidateSourceHash,
  sealedExecutionSourceHashes: [candidateSourceHash],
  gameToolCallCount: 1,
};

const observation = (
  scenario: FrameInputWindowScenarioV1,
  jumping = scenario.expectedJumping,
): FrameInputWindowObservationV1 => ({
  schemaVersion: 1,
  scenarioId: scenario.scenarioId,
  sourceHash: scenario.expectedSourceHash,
  realizedFixedFps: scenario.fixedFps,
  realizedPhysicsTicksPerSecond: scenario.physicsTicksPerSecond,
  requestedInputTimeUs: scenario.inputTimeUs,
  realizedInputTimeUs: scenario.inputTimeUs,
  jumping,
  processFrames: 40,
  physicsTicks: 40,
  runtimeStatus: "completed",
  protocolErrors: [],
  droppedEventCount: 0,
  observationComplete: true,
});

const putEvidenceExecution = async (input: {
  readonly store: VNextRuntimeStore;
  readonly taskId: ReturnType<typeof asTaskId>;
  readonly executionId: string;
  readonly sourceHash: typeof candidateSourceHash;
  readonly sealLedger?: boolean;
  readonly omitRecordedEvent?: boolean;
  readonly corruptRecordHash?: boolean;
}): Promise<void> => {
  const runtimeId = `runtime:${input.executionId}`;
  const buildId = `build:${input.executionId}`;
  const sourceId = `source:${input.executionId}`;
  const workspaceId = `workspace:${input.executionId}`;
  const event = VNextRawRuntimeEventV1Schema.parse({
    schemaVersion: 1,
    eventId: `event:${input.executionId}`,
    taskId: input.taskId,
    executionId: input.executionId,
    runtimeId,
    buildId,
    sequence: 0,
    channel: "clock",
    kind: "clock",
    clock: {
      schemaVersion: 1,
      processFrame: 1,
      physicsTick: 1,
      simulationTimeUs: 16_667,
      hostMonotonicUs: 10,
      renderFrame: null,
    },
    payload: { phase: "process_frame_end" },
    observedRelations: [],
  });
  await input.store.appendExecutionEvent(
    input.taskId,
    input.executionId,
    event,
    (value) => VNextRawRuntimeEventV1Schema.parse(value),
  );
  const physicalSeal =
    input.sealLedger === false
      ? {
          schemaVersion: 1 as const,
          taskId: input.taskId,
          executionId: input.executionId,
          count: 1,
          headHash: "1".repeat(64),
          byteLength: 1,
          contentHash: "2".repeat(64),
        }
      : await input.store.sealExecution(input.taskId, input.executionId);
  const capturePolicy = {
    schemaVersion: 1 as const,
    requestedRetentionUs: 1,
    requestedRetentionTicks: 1,
    memoryBudgetBytes: 1_024,
    diskBudgetBytes: 1_024,
    maxAverageOverheadRatio: 1,
    maxMainThreadBlockUs: 1_000,
    channels: [],
  };
  const recordBasis = {
    schemaVersion: 1 as const,
    taskId: input.taskId,
    executionId: input.executionId,
    runtimeId,
    buildId,
    manifest: {
      schemaVersion: 1 as const,
      taskId: input.taskId,
      executionId: input.executionId,
      runtimeId,
      workspaceId,
      sourceId,
      buildId,
      adapterId: `adapter:${input.executionId}`,
      stateSchemaVersion: "frame-input-window:v1",
      probeIds: [],
      traceId: null,
      startCheckpointId: null,
      branchId: null,
      launchTarget: "res://main.tscn",
      launchParameters: { executionSeal: physicalSeal },
      controls: {
        schemaVersion: 1 as const,
        requested: {
          schemaVersion: 1 as const,
          fixedFps: 60,
          physicsTicksPerSecond: 60,
          timeScale: 1,
          paused: false,
          headless: true,
        },
        realized: {
          schemaVersion: 1 as const,
          fixedFps: 60,
          physicsTicksPerSecond: 60,
          timeScale: 1,
          paused: false,
          headless: true,
        },
        mismatches: [],
        knownSideEffects: [],
      },
      clockDomains: ["process_frame" as const],
      capturePolicy,
      startedAt: "2026-08-07T00:00:00.000Z",
    },
    captureProfile: {
      schemaVersion: 1 as const,
      requested: capturePolicy,
      realizedRetentionUs: 1,
      realizedRetentionTicks: 1,
      peakMemoryBytes: 0,
      writtenBytes: 0,
      averageOverheadRatio: 0,
      maxMainThreadBlockUs: 0,
      budgetStatus: "within_budget" as const,
      degradationReasons: [],
      gameplayPausedForCapture: false as const,
    },
    events: input.omitRecordedEvent === true ? [] : [event],
    coverage: [],
    loss: [],
    status: "stopped" as const,
    sealed: true as const,
    endedAt: "2026-08-07T00:00:01.000Z",
    termination: {
      schemaVersion: 1 as const,
      code: "requested_stop",
      message: null,
    },
  };
  const record = VNextExecutionRecordV1Schema.parse({
    ...recordBasis,
    recordHash: input.corruptRecordHash
      ? "3".repeat(64)
      : contentHash(JsonValueSchema.parse(recordBasis)),
  });
  await input.store.putResourceOnce(
    input.taskId,
    "execution",
    input.executionId,
    record,
    (value) => VNextExecutionRecordV1Schema.parse(value),
  );
  const build = VNextBuildV1Schema.parse({
    schemaVersion: 1,
    taskId: input.taskId,
    workspaceId,
    sourceId,
    buildId,
    sourceHash: input.sourceHash,
    workspaceDiffHash: "4".repeat(64),
    buildConfigurationHash: "5".repeat(64),
    outputHash: "6".repeat(64),
    createdAt: "2026-08-07T00:00:00.000Z",
  });
  await input.store.putResourceOnce(
    input.taskId,
    "build",
    buildId,
    build,
    (value) => VNextBuildV1Schema.parse(value),
  );
};

describe("frame-input-window external release acceptance", () => {
  it("derives model and game-call evidence from immutable Task stores instead of a caller summary", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-m3-evidence-"));
    try {
      const runtimeRoot = join(root, "runtime");
      const sourceRoot = join(root, "source");
      await Promise.all([mkdir(runtimeRoot), mkdir(sourceRoot)]);
      const taskId = asTaskId("task:m3-evidence");
      await createTaskDirectoryLayout({
        runtimeRoot,
        sourceRepositoryRoot: sourceRoot,
        taskId,
      });
      const taskStore = new VNextTaskStore(runtimeRoot);
      const runtimeStore = new VNextRuntimeStore(runtimeRoot);
      await Promise.all([
        taskStore.create(taskId),
        runtimeStore.create(taskId),
      ]);
      const task = VNextAgentTaskV2Schema.parse({
        schemaVersion: 2,
        taskId,
        goal: "Fix the observable input window",
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        thinkingLevel: "max",
        createdAt: "2026-08-07T00:00:00.000Z",
        gameCapability: {
          schemaVersion: 1,
          capabilityKind: "chronorift-m3-game-tools",
          toolCatalogVersion: 1,
          fixtureId: "frame-input-window",
          managedRuntimeId: `managed-godot-runtime:v1:${"d".repeat(64)}`,
          toolNames: [
            "game_capabilities",
            "game_launch",
            "game_status",
            "game_stop",
            "game_capture_configure",
            "game_capture_pin",
            "game_query",
            "game_input",
            "game_step",
            "game_set_controls",
            "game_checkpoint_create",
            "game_checkpoint_restore",
            "game_fork",
            "game_trace_create",
            "game_trace_replay",
            "game_compare",
          ],
        },
      });
      await taskStore.putJsonOnce(taskId, "agent-task.json", task, (value) =>
        VNextAgentTaskV2Schema.parse(value),
      );
      const validTurn = VNextAgentTurnV1Schema.parse({
        schemaVersion: 1,
        taskId,
        turn: 1,
        kind: "start",
        prompt: task.goal,
        sessionId: "session:m3-evidence",
        sessionFile: "session.jsonl",
        status: "completed",
        provider: task.provider,
        model: task.model,
        requestedThinkingLevel: task.thinkingLevel,
        realizedThinkingLevel: task.thinkingLevel,
        activeTools: task.gameCapability.toolNames,
        assistantText: "Candidate ready",
        errorMessage: null,
        eventsObserved: 4,
        stats: {
          userMessages: 1,
          assistantMessages: 1,
          toolCalls: 1,
          toolResults: 1,
          totalMessages: 4,
          tokens: {
            input: 10,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            total: 20,
          },
          cost: 0,
        },
        completedAt: "2026-08-07T00:01:00.000Z",
      });
      await taskStore.append(taskId, "agent-turns.jsonl", validTurn, (value) =>
        VNextAgentTurnV1Schema.parse(value),
      );
      const patch = TaskPatchIdentityV1Schema.parse({
        schemaVersion: 1,
        patchId: `patch:v1:${"e".repeat(64)}`,
        taskId,
        baselineSourceHash,
        candidateSourceHash,
        patchHash: "e".repeat(64),
        byteLength: 42,
      });
      await taskStore.putJsonOnce(taskId, "patch.json", patch, (value) =>
        TaskPatchIdentityV1Schema.parse(value),
      );
      await runtimeStore.putResourceOnce(
        taskId,
        "tool-call",
        "tool-call:m3-evidence",
        {
          schemaVersion: 1,
          taskId,
          toolCallId: "tool-call:m3-evidence",
          toolName: "game_capabilities",
          startedAt: "2026-08-07T00:00:10.000Z",
          endedAt: "2026-08-07T00:00:11.000Z",
          input: { schemaVersion: 1, taskId },
          response: {
            schemaVersion: 1,
            toolCallId: "tool-call:m3-evidence",
            outcome: "success",
            output: {},
          },
        },
        (value) => JsonValueSchema.parse(value),
      );
      await putEvidenceExecution({
        store: runtimeStore,
        taskId,
        executionId: "execution:zz-good",
        sourceHash: candidateSourceHash,
      });

      await expect(
        collectM3LiveTaskEvidenceV1({ taskId, runtimeRoot }),
      ).resolves.toEqual({
        candidateSourceHash,
        patchHash: patch.patchHash,
        patchByteLength: patch.byteLength,
        evidence: {
          schemaVersion: 1,
          provider: "openai-codex",
          model: "gpt-5.6-luna",
          thinkingLevel: "max",
          loopStatus: "completed",
          finalCandidateSourceHash: candidateSourceHash,
          sealedExecutionSourceHashes: [candidateSourceHash],
          gameToolCallCount: 1,
        },
      });

      const putTurnVariant = async (
        variantTaskId: ReturnType<typeof asTaskId>,
        turnOverrides: Partial<typeof validTurn>,
      ): Promise<void> => {
        await createTaskDirectoryLayout({
          runtimeRoot,
          sourceRepositoryRoot: sourceRoot,
          taskId: variantTaskId,
        });
        await Promise.all([
          taskStore.create(variantTaskId),
          runtimeStore.create(variantTaskId),
        ]);
        await taskStore.putJsonOnce(
          variantTaskId,
          "agent-task.json",
          VNextAgentTaskV2Schema.parse({ ...task, taskId: variantTaskId }),
          (value) => VNextAgentTaskV2Schema.parse(value),
        );
        await taskStore.append(
          variantTaskId,
          "agent-turns.jsonl",
          VNextAgentTurnV1Schema.parse({
            ...validTurn,
            taskId: variantTaskId,
            ...turnOverrides,
          }),
          (value) => VNextAgentTurnV1Schema.parse(value),
        );
        await taskStore.putJsonOnce(
          variantTaskId,
          "patch.json",
          TaskPatchIdentityV1Schema.parse({
            ...patch,
            taskId: variantTaskId,
          }),
          (value) => TaskPatchIdentityV1Schema.parse(value),
        );
      };

      const lowerThinkingTaskId = asTaskId("task:m3-evidence-realized-high");
      await putTurnVariant(lowerThinkingTaskId, {
        realizedThinkingLevel: "high",
      });
      await expect(
        collectM3LiveTaskEvidenceV1({
          taskId: lowerThinkingTaskId,
          runtimeRoot,
        }),
      ).rejects.toThrow(/requires realized .*\/max/u);

      const incompleteToolsTaskId = asTaskId(
        "task:m3-evidence-incomplete-tools",
      );
      await putTurnVariant(incompleteToolsTaskId, {
        activeTools: validTurn.activeTools.slice(1),
      });
      await expect(
        collectM3LiveTaskEvidenceV1({
          taskId: incompleteToolsTaskId,
          runtimeRoot,
        }),
      ).rejects.toThrow(/complete game tool set/u);

      await putEvidenceExecution({
        store: runtimeStore,
        taskId,
        executionId: "execution:z-raw-mismatch",
        sourceHash: candidateSourceHash,
        omitRecordedEvent: true,
      });
      await expect(
        collectM3LiveTaskEvidenceV1({ taskId, runtimeRoot }),
      ).rejects.toThrow(/does not match its raw ledger/u);

      await putEvidenceExecution({
        store: runtimeStore,
        taskId,
        executionId: "execution:a-hash-mismatch",
        sourceHash: candidateSourceHash,
        corruptRecordHash: true,
      });
      await expect(
        collectM3LiveTaskEvidenceV1({ taskId, runtimeRoot }),
      ).rejects.toThrow(/recordHash does not match/u);

      await putEvidenceExecution({
        store: runtimeStore,
        taskId,
        executionId: "execution:0-missing-seal",
        sourceHash: candidateSourceHash,
        sealLedger: false,
      });
      await expect(
        collectM3LiveTaskEvidenceV1({ taskId, runtimeRoot }),
      ).rejects.toThrow(/Artifact not found/u);

      await taskStore.append(
        taskId,
        "agent-turns.jsonl",
        VNextAgentTurnV1Schema.parse({
          schemaVersion: 1,
          taskId,
          turn: 2,
          kind: "continue",
          prompt: "A second attempt must not be accepted",
          sessionId: "session:m3-evidence",
          sessionFile: "session.jsonl",
          status: "completed",
          provider: task.provider,
          model: task.model,
          requestedThinkingLevel: task.thinkingLevel,
          realizedThinkingLevel: task.thinkingLevel,
          activeTools: task.gameCapability.toolNames,
          assistantText: "Second candidate",
          errorMessage: null,
          eventsObserved: 0,
          stats: {
            userMessages: 1,
            assistantMessages: 1,
            toolCalls: 0,
            toolResults: 0,
            totalMessages: 2,
            tokens: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              total: 2,
            },
            cost: 0,
          },
          completedAt: "2026-08-07T00:02:00.000Z",
        }),
        (value) => VNextAgentTurnV1Schema.parse(value),
      );
      await expect(
        collectM3LiveTaskEvidenceV1({ taskId, runtimeRoot }),
      ).rejects.toThrow(/exactly one Agent start turn/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("freezes the baseline reproduction and the 12-case positive/negative candidate matrix", () => {
    const matrix = createFrameInputWindowAcceptanceMatrixV1({
      baselineSourceHash,
      candidateSourceHash,
    });
    expect(matrix).toHaveLength(13);
    expect(matrix[0]).toMatchObject({
      subject: "baseline",
      fixedFps: 120,
      physicsTicksPerSecond: 60,
      inputTimeUs: 75_000,
      expectedJumping: false,
    });
    expect(
      matrix.filter(
        (entry) =>
          entry.subject === "candidate" && entry.inputTimeUs === 75_000,
      ),
    ).toHaveLength(4);
    expect(
      matrix.filter(
        (entry) =>
          entry.subject === "candidate" && entry.inputTimeUs === 250_000,
      ),
    ).toHaveLength(4);
    expect(
      matrix.filter(
        (entry) => entry.subject === "candidate" && entry.inputTimeUs === null,
      ),
    ).toHaveLength(4);
  });

  it("accepts only mechanism-neutral observed behavior with matching source and realized controls", async () => {
    const runner: FrameInputWindowScenarioRunnerV1 = {
      run: (scenario) => Promise.resolve(observation(scenario)),
    };
    const result = await runFrameInputWindowReleaseAcceptanceV1({
      baselineSourceHash,
      candidateSourceHash,
      taskEvidence,
      runner,
    });
    expect(result).toMatchObject({ outcome: "evaluated", accepted: true });
  });

  it("rejects always-jump gaming, source drift, and event loss without prescribing a patch", async () => {
    const runner: FrameInputWindowScenarioRunnerV1 = {
      run: (scenario) => {
        const value =
          scenario.subject === "baseline"
            ? observation(scenario)
            : observation(scenario, true);
        return Promise.resolve(
          scenario.inputTimeUs === 250_000
            ? { ...value, droppedEventCount: 1 }
            : scenario.inputTimeUs === null
              ? { ...value, sourceHash: baselineSourceHash }
              : value,
        );
      },
    };
    const result = await runFrameInputWindowReleaseAcceptanceV1({
      baselineSourceHash,
      candidateSourceHash,
      taskEvidence,
      runner,
    });
    expect(result).toMatchObject({ outcome: "evaluated", accepted: false });
    if (result.outcome !== "evaluated") throw new Error("unexpected outcome");
    expect(result.scenarios.some((entry) => !entry.matched)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /frame_input_window\.gd|sourceSymbol|mechanismCode/u,
    );
  });

  it("rejects observed protocol errors and incomplete zero-count coverage", async () => {
    const result = await runFrameInputWindowReleaseAcceptanceV1({
      baselineSourceHash,
      candidateSourceHash,
      taskEvidence,
      runner: {
        run: (scenario) => {
          const value = observation(scenario);
          if (scenario.subject === "baseline") return Promise.resolve(value);
          return Promise.resolve({
            ...value,
            protocolErrors: ["runtime error event event:protocol"],
            observationComplete: false,
          });
        },
      },
    });
    expect(result).toMatchObject({ outcome: "evaluated", accepted: false });
    if (result.outcome !== "evaluated") throw new Error("unexpected outcome");
    const firstCandidate = result.scenarios.find(
      (entry) => entry.scenario.subject === "candidate",
    );
    expect(firstCandidate).toMatchObject({
      outcome: "observed",
      matched: false,
      failures: [
        "Godot runtime/protocol reported an error",
        "runtime observation coverage was incomplete",
      ],
    });
  });

  it("classifies runner failure as retryable infrastructure, not an evaluated rejection", async () => {
    let calls = 0;
    const result = await runFrameInputWindowReleaseAcceptanceV1({
      baselineSourceHash,
      candidateSourceHash,
      taskEvidence,
      runner: {
        run: (scenario) => {
          calls += 1;
          if (calls === 3) throw new Error("sandbox delegation unavailable");
          return Promise.resolve(observation(scenario));
        },
      },
    });
    expect(result).toMatchObject({
      outcome: "infrastructure_failure",
      message: "sandbox delegation unavailable",
    });
    if (result.outcome !== "infrastructure_failure") {
      throw new Error("unexpected outcome");
    }
    expect(result.completedScenarioIds).toHaveLength(2);
  });

  it("classifies frozen-baseline mismatch as retryable evaluator infrastructure", async () => {
    let calls = 0;
    const result = await runFrameInputWindowReleaseAcceptanceV1({
      baselineSourceHash,
      candidateSourceHash,
      taskEvidence,
      runner: {
        run: (scenario) => {
          calls += 1;
          return Promise.resolve(observation(scenario, true));
        },
      },
    });
    expect(calls).toBe(1);
    expect(result.outcome).toBe("infrastructure_failure");
    if (result.outcome !== "infrastructure_failure") {
      throw new Error("unexpected outcome");
    }
    expect(result.message).toMatch(/frozen baseline reproduction/u);
    expect(
      planM3LiveAcceptanceAttemptV1({
        candidateSourceHash,
        history: [result],
      }),
    ).toMatchObject({ kind: "evaluator_retry", candidateSourceHash });
  });

  it("turns a cleaned candidate runtime failure into an evaluated rejection that identical bytes cannot retry", async () => {
    let calls = 0;
    const result = await runFrameInputWindowReleaseAcceptanceV1({
      baselineSourceHash,
      candidateSourceHash,
      taskEvidence,
      runner: {
        run: (scenario) => {
          calls += 1;
          if (scenario.subject === "baseline") {
            return Promise.resolve(observation(scenario));
          }
          throw new FrameInputWindowCandidateExecutionError({
            schemaVersion: 1,
            scenarioId: scenario.scenarioId,
            stage: "step",
            toolName: "game_step",
            error: {
              code: "runtime_crashed",
              message: "candidate runtime exited during step",
            },
            expectedSourceHash: scenario.expectedSourceHash,
            requestedControls: {
              fixedFps: scenario.fixedFps,
              physicsTicksPerSecond: scenario.physicsTicksPerSecond,
              maxTicks: 64,
              inputTimeUs: scenario.inputTimeUs,
            },
            cleanupProven: true,
          });
        },
      },
    });

    expect(result).toMatchObject({ outcome: "evaluated", accepted: false });
    if (result.outcome !== "evaluated") throw new Error("unexpected outcome");
    expect(calls).toBe(2);
    expect(result.scenarios).toHaveLength(2);
    expect(result.scenarios[0]).toMatchObject({
      outcome: "observed",
      matched: true,
    });
    expect(result.scenarios[1]).toMatchObject({
      schemaVersion: 1,
      outcome: "candidate_execution_failed",
      scenario: { subject: "candidate" },
      failure: {
        stage: "step",
        toolName: "game_step",
        error: {
          code: "runtime_crashed",
          message: "candidate runtime exited during step",
        },
        expectedSourceHash: candidateSourceHash,
        cleanupProven: true,
      },
      matched: false,
    });
    expect(result.scenarios[1]).not.toHaveProperty("observation");
    expect(() =>
      planM3LiveAcceptanceAttemptV1({
        candidateSourceHash,
        history: [result],
      }),
    ).toThrow(/different candidate source identity/u);
  });

  it("does not accept candidate-failure evidence for the baseline scenario", async () => {
    const result = await runFrameInputWindowReleaseAcceptanceV1({
      baselineSourceHash,
      candidateSourceHash,
      taskEvidence,
      runner: {
        run: (scenario) => {
          throw new FrameInputWindowCandidateExecutionError({
            schemaVersion: 1,
            scenarioId: scenario.scenarioId,
            stage: "launch",
            toolName: "game_launch",
            error: {
              code: "runtime_unavailable",
              message: "host runtime unavailable",
            },
            expectedSourceHash: scenario.expectedSourceHash,
            requestedControls: {
              fixedFps: scenario.fixedFps,
              physicsTicksPerSecond: scenario.physicsTicksPerSecond,
              maxTicks: 64,
              inputTimeUs: scenario.inputTimeUs,
            },
            cleanupProven: true,
          });
        },
      },
    });
    expect(result).toMatchObject({
      outcome: "infrastructure_failure",
      message:
        "candidate execution failure evidence did not match the requested scenario",
    });
  });

  it("requires an actual final-candidate game execution from the Luna/max task", async () => {
    const result = await runFrameInputWindowReleaseAcceptanceV1({
      baselineSourceHash,
      candidateSourceHash,
      taskEvidence: {
        ...taskEvidence,
        sealedExecutionSourceHashes: [baselineSourceHash],
        gameToolCallCount: 0,
      },
      runner: { run: (scenario) => Promise.resolve(observation(scenario)) },
    });
    expect(result).toMatchObject({ outcome: "evaluated", accepted: false });
    if (result.outcome !== "evaluated") throw new Error("unexpected outcome");
    expect(result.taskEvidenceFailures).toEqual([
      "live Agent did not call a game tool",
      "no sealed Agent execution used the final candidate source identity",
    ]);
  });

  it("treats provider termination as infrastructure rather than an oracle result", async () => {
    let scenarioCalls = 0;
    const result = await runFrameInputWindowReleaseAcceptanceV1({
      baselineSourceHash,
      candidateSourceHash,
      taskEvidence: { ...taskEvidence, loopStatus: "provider_failed" },
      runner: {
        run: (scenario) => {
          scenarioCalls += 1;
          return Promise.resolve(observation(scenario));
        },
      },
    });
    expect(result).toMatchObject({
      outcome: "infrastructure_failure",
      message: "live Agent turn ended with provider_failed",
    });
    expect(scenarioCalls).toBe(0);
  });

  it("retries infrastructure on identical bytes but requires new bytes after an evaluated rejection", async () => {
    const runner = {
      run: (scenario: FrameInputWindowScenarioV1) =>
        Promise.resolve(observation(scenario)),
    };
    const infrastructure = await runFrameInputWindowReleaseAcceptanceV1({
      baselineSourceHash,
      candidateSourceHash,
      taskEvidence: { ...taskEvidence, loopStatus: "timed_out" },
      runner,
    });
    expect(
      planM3LiveAcceptanceAttemptV1({
        candidateSourceHash,
        history: [infrastructure],
      }),
    ).toMatchObject({ kind: "evaluator_retry", candidateSourceHash });

    const rejected = await runFrameInputWindowReleaseAcceptanceV1({
      baselineSourceHash,
      candidateSourceHash,
      taskEvidence: {
        ...taskEvidence,
        sealedExecutionSourceHashes: [],
      },
      runner,
    });
    expect(() =>
      planM3LiveAcceptanceAttemptV1({
        candidateSourceHash,
        history: [infrastructure, rejected],
      }),
    ).toThrow(/different candidate source identity/u);
    expect(
      planM3LiveAcceptanceAttemptV1({
        candidateSourceHash: asSha256DigestV1("c".repeat(64)),
        history: [rejected],
      }),
    ).toMatchObject({ kind: "agent_attempt" });
  });

  it("bounds evaluator-only retry to the same candidate without a second Agent attempt", async () => {
    let agentAttempts = 0;
    let evaluatorAttempts = 0;
    let cleanupProofsBeforeRetry = 0;
    agentAttempts += 1;
    const result = await runM3BoundedEvaluatorOnlyAcceptanceV1({
      baselineSourceHash,
      candidateSourceHash,
      taskEvidence,
      maximumAttempts: 2,
      beforeRetry: ({ completedAttempts, history }) => {
        expect(completedAttempts).toBe(1);
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({
          outcome: "infrastructure_failure",
          candidateSourceHash,
        });
        cleanupProofsBeforeRetry += 1;
        return Promise.resolve();
      },
      createRunner: (attempt) => {
        evaluatorAttempts += 1;
        return {
          run: (scenario) => {
            if (attempt === 1) {
              throw new Error("transient evaluator failure");
            }
            return Promise.resolve(observation(scenario));
          },
        };
      },
    });

    expect(agentAttempts).toBe(1);
    expect(evaluatorAttempts).toBe(2);
    expect(cleanupProofsBeforeRetry).toBe(1);
    expect(result.attempts).toBe(2);
    expect(result.history).toHaveLength(2);
    expect(result.history[0]).toMatchObject({
      outcome: "infrastructure_failure",
      candidateSourceHash,
    });
    expect(result.acceptance).toMatchObject({
      outcome: "evaluated",
      accepted: true,
      candidateSourceHash,
    });
  });

  it("does not retry an evaluated rejection and emits only a sanitized deterministic success summary", async () => {
    let runnerCreations = 0;
    const rejected = await runM3BoundedEvaluatorOnlyAcceptanceV1({
      baselineSourceHash,
      candidateSourceHash,
      taskEvidence,
      maximumAttempts: 2,
      createRunner: () => {
        runnerCreations += 1;
        return {
          run: (scenario) =>
            Promise.resolve(
              scenario.subject === "candidate"
                ? observation(scenario, !scenario.expectedJumping)
                : observation(scenario),
            ),
        };
      },
    });
    expect(rejected.acceptance).toMatchObject({
      outcome: "evaluated",
      accepted: false,
    });
    expect(runnerCreations).toBe(1);

    const accepted = await runFrameInputWindowReleaseAcceptanceV1({
      baselineSourceHash,
      candidateSourceHash,
      taskEvidence,
      runner: { run: (scenario) => Promise.resolve(observation(scenario)) },
    });
    const summary = createM3LiveAcceptanceSummaryV1({
      acceptance: accepted,
      evaluatorAttempts: 2,
      cleanupProven: true,
    });
    expect(summary).toEqual({
      schemaVersion: 1,
      evaluator: "frame-input-window-release-acceptance-v1",
      releaseCandidateId: accepted.releaseCandidateId,
      candidateSourceHash,
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      thinkingLevel: "max",
      agentTurns: 1,
      evaluatorAttempts: 2,
      observedScenarios: 13,
      accepted: true,
      cleanupProven: true,
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /task:|\/tmp|prompt|assistant|message|failure/iu,
    );
  });

  it("does not start a second evaluator attempt while prior setup cleanup is unproven", async () => {
    let runnerCreations = 0;
    await expect(
      runM3BoundedEvaluatorOnlyAcceptanceV1({
        baselineSourceHash,
        candidateSourceHash,
        taskEvidence,
        maximumAttempts: 2,
        beforeRetry: () =>
          Promise.reject(new Error("retained setup owner remains live")),
        createRunner: () => {
          runnerCreations += 1;
          return {
            run: () => {
              throw new Error("transient evaluator failure");
            },
          };
        },
      }),
    ).rejects.toThrow(/retained setup owner remains live/u);
    expect(runnerCreations).toBe(1);
  });
});
