import {
  asAdapterId,
  asBuildId,
  asExecutionId,
  asRuntimeId,
  asSha256DigestV1,
  asSourceId,
  asTaskId,
  asWorkspaceId,
  type JsonValue,
} from "@chronorift/domain";
import {
  GAME_TOOL_NAMES_V1,
  type GameToolNameV1,
} from "@chronorift/agent-protocol";
import {
  type VNextGameToolPort,
  type VNextGameToolPortRequestV1,
} from "@chronorift/pi-harness";
import { describe, expect, it } from "vitest";

import {
  FrameInputWindowCandidateExecutionError,
  FrameInputWindowScenarioV1Schema,
  type FrameInputWindowScenarioV1,
} from "./frame-input-window-release-acceptance.js";
import {
  FrameInputWindowRunnerInfrastructureError,
  cleanupFrameInputWindowEvaluatorOwnershipV1,
  cleanupFrameInputWindowReleaseRootV1,
  createFrameInputWindowGameToolScenarioRunnerV1,
  frameInputWindowProcessTickV1,
  type FrameInputWindowEvaluatorTaskFactoryV1,
} from "./frame-input-window-game-tool-runner.js";

const baselineHash = asSha256DigestV1("a".repeat(64));
const candidateHash = asSha256DigestV1("b".repeat(64));

const scenario = (
  overrides: Partial<FrameInputWindowScenarioV1> = {},
): FrameInputWindowScenarioV1 =>
  FrameInputWindowScenarioV1Schema.parse({
    schemaVersion: 1,
    scenarioId: "frame-input-window:0123456789abcdef01234567",
    subject: "candidate",
    expectedSourceHash: candidateHash,
    fixedFps: 120,
    physicsTicksPerSecond: 60,
    inputTimeUs: 75_000,
    expectedJumping: true,
    ...overrides,
  });

const clock = (input: {
  readonly processFrame: number;
  readonly physicsTick: number;
  readonly simulationTimeUs: number;
}) => ({
  schemaVersion: 1 as const,
  ...input,
  hostMonotonicUs: input.processFrame === 0 ? 0 : input.processFrame + 1_000,
  renderFrame: null,
});

interface FakeTaskOptions {
  readonly taskId: ReturnType<typeof asTaskId>;
  readonly sourceHash: typeof candidateHash;
  readonly jumping?: boolean;
  readonly lossCount?: number;
  readonly corruptStepOutput?: boolean;
  readonly errorTool?: GameToolNameV1;
  readonly errorCode?:
    "runtime_crashed" | "runtime_unavailable" | "operation_failed";
  readonly errorDetails?: JsonValue;
  readonly stopError?: boolean;
  readonly stopStatus?: "stopped" | "failed";
  readonly protocolError?: string;
  readonly coverageStatus?: "full" | "sampled" | "partial" | "unavailable";
  readonly lossKind?:
    | "degraded"
    | "sampled"
    | "dropped"
    | "overwritten"
    | "unavailable"
    | "observer_effect";
  readonly queryIncomplete?: boolean;
}

const createFakeTask = (options: FakeTaskOptions) => {
  const calls: VNextGameToolPortRequestV1[] = [];
  const buildId = asBuildId(`build:${options.taskId}`);
  const sourceId = asSourceId(`source:${options.taskId}`);
  const runtimeId = asRuntimeId(`runtime:${options.taskId}`);
  const executionId = asExecutionId(`execution:${options.taskId}`);
  const workspaceId = asWorkspaceId(`workspace:${options.taskId}`);
  const adapterId = asAdapterId(`adapter:${options.taskId}`);
  const startedAt = "2026-08-07T00:00:00.000Z";
  let fixedFps: 60 | 120 = 120;
  let physicsTicksPerSecond: 60 | 120 = 60;
  let requestedInput:
    | {
        readonly requestId: string;
        readonly requested: {
          readonly clock: "process_frame";
          readonly requestedTick: number;
          readonly requestedPhase: "process_frame_start";
        };
      }
    | undefined;

  const build = {
    schemaVersion: 1 as const,
    taskId: options.taskId,
    workspaceId,
    sourceId,
    buildId,
    sourceHash: options.sourceHash,
    workspaceDiffHash: asSha256DigestV1("c".repeat(64)),
    buildConfigurationHash: asSha256DigestV1("d".repeat(64)),
    outputHash: asSha256DigestV1("e".repeat(64)),
    createdAt: startedAt,
  };
  const runtime = (status: "running" | "stopped" | "failed") => ({
    schemaVersion: 1 as const,
    taskId: options.taskId,
    runtimeId,
    buildId,
    sourceId,
    adapter: {
      schemaVersion: 1 as const,
      adapterId,
      contentHash: asSha256DigestV1("f".repeat(64)),
      protocolVersion: "2",
    },
    probes: [],
    capabilities: [
      "observe.property_sampling",
      "control.input_event_action",
      "clock.process_frame",
    ],
    startedAt,
    status,
    ...(status === "running"
      ? {}
      : {
          endedAt: "2026-08-07T00:01:00.000Z",
          termination: {
            schemaVersion: 1 as const,
            code: status === "stopped" ? "requested_stop" : "runtime_failed",
            message: status === "stopped" ? null : "candidate runtime failed",
          },
        }),
  });
  const captureEvidence = (stepsUsed: number) => {
    const position = clock({
      processFrame: stepsUsed,
      physicsTick: Math.floor((stepsUsed * physicsTicksPerSecond) / fixedFps),
      simulationTimeUs: stepsUsed * Math.round(1_000_000 / fixedFps),
    });
    const lossKind =
      options.lossKind ?? ((options.lossCount ?? 0) > 0 ? "dropped" : null);
    const status =
      options.coverageStatus ?? (lossKind === null ? "full" : "partial");
    return {
      coverage: [
        {
          schemaVersion: 1 as const,
          channel: "error" as const,
          status,
          availableRange:
            status === "unavailable"
              ? null
              : {
                  schemaVersion: 1 as const,
                  from: clock({
                    processFrame: 0,
                    physicsTick: 0,
                    simulationTimeUs: 0,
                  }),
                  through: position,
                },
          requestedSampleEvery: 1,
          realizedSampleEvery: status === "unavailable" ? null : 1,
          emittedRecords: options.protocolError === undefined ? 0 : 1,
          droppedRecords: lossKind === "dropped" ? (options.lossCount ?? 0) : 0,
          overwrittenRecords:
            lossKind === "overwritten" ? (options.lossCount ?? 0) : 0,
          observerEffectUs: 0,
          limitations:
            status === "full" ? [] : [`synthetic ${status} coverage`],
        },
      ],
      loss:
        lossKind === null
          ? []
          : [
              {
                schemaVersion: 1 as const,
                sequence: 0,
                channel: "error" as const,
                kind: lossKind,
                count: options.lossCount ?? 0,
                firstClock: position,
                lastClock: position,
                reason: "synthetic loss",
              },
            ],
    };
  };
  const runtimeFacts = (
    status: "running" | "stopped" | "failed",
    stepsUsed: number,
  ) => ({
    runtime: runtime(status),
    runtimeId,
    executionId,
    state: {
      values: {
        "player.jumping": stepsUsed === 0 ? false : (options.jumping ?? true),
      },
    },
    clocks: clock({
      processFrame: stepsUsed,
      physicsTick: Math.floor((stepsUsed * physicsTicksPerSecond) / fixedFps),
      simulationTimeUs: stepsUsed * Math.round(1_000_000 / fixedFps),
    }),
    controls: {
      fixedFps,
      physicsTicksPerSecond,
      maxTicks: 64,
      stepsUsed,
    },
    ...captureEvidence(stepsUsed),
  });

  const success = (request: VNextGameToolPortRequestV1, output: JsonValue) => ({
    schemaVersion: 1 as const,
    toolCallId: request.toolCallId,
    outcome: "success" as const,
    output,
  });
  const port: VNextGameToolPort = {
    invoke: (request) => {
      calls.push(request);
      if (
        request.toolName === GAME_TOOL_NAMES_V1.stop &&
        options.stopError === true
      ) {
        return Promise.resolve({
          schemaVersion: 1,
          toolCallId: request.toolCallId,
          outcome: "error",
          error: {
            code: "runtime_unavailable",
            message: "cleanup stop failed",
            recoverable: true,
          },
        });
      }
      if (request.toolName === options.errorTool) {
        return Promise.resolve({
          schemaVersion: 1,
          toolCallId: request.toolCallId,
          outcome: "error",
          error: {
            code: options.errorCode ?? "runtime_unavailable",
            message: "delegated runtime failed",
            recoverable: true,
            ...(options.errorDetails === undefined
              ? {}
              : { details: options.errorDetails }),
          },
        });
      }
      switch (request.toolName) {
        case GAME_TOOL_NAMES_V1.capabilities:
          return Promise.resolve(
            success(request, {
              schemaVersion: 1,
              taskId: options.taskId,
              workspaceId,
              build,
              fixture: {
                fixtureId: "frame-input-window",
                inputActions: ["attempt_jump"],
                frameRates: [60, 120],
                physicsRates: [60, 120],
                maxTicks: 600,
              },
              tools: Object.values(GAME_TOOL_NAMES_V1).map((name) => ({
                name,
                capability: `capability.${name}`,
              })),
              costs: {
                rollingHistorySecondsMaximum: 10,
                queryRowMaximum: 200,
                traceEventMaximum: 128,
              },
              unsupported: [],
              runtime: null,
            }),
          );
        case GAME_TOOL_NAMES_V1.launch: {
          const input = request.input as {
            controls: {
              fixedFps: 60 | 120;
              physicsTicksPerSecond: 60 | 120;
            };
          };
          fixedFps = input.controls.fixedFps;
          physicsTicksPerSecond = input.controls.physicsTicksPerSecond;
          return Promise.resolve(
            success(request, {
              ...runtimeFacts("running", 0),
              build: { buildId, sourceId, sourceHash: options.sourceHash },
            }),
          );
        }
        case GAME_TOOL_NAMES_V1.input: {
          const input = request.input as {
            requested: {
              clock: "process_frame";
              requestedTick: number;
              requestedPhase: "process_frame_start";
            };
          };
          requestedInput = {
            requestId: `input:${options.taskId}`,
            requested: input.requested,
          };
          return Promise.resolve(
            success(request, {
              runtimeId,
              requestId: requestedInput.requestId,
              action: "attempt_jump",
              requested: requestedInput.requested,
              queued: true,
              realized: null,
            }),
          );
        }
        case GAME_TOOL_NAMES_V1.step: {
          if (options.corruptStepOutput === true) {
            return Promise.resolve(success(request, { runtimeId }));
          }
          const input = request.input as { count: number };
          const deltaUs = Math.round(1_000_000 / fixedFps);
          const processFrames = input.count;
          const physicsTicks = Math.floor(
            (processFrames * physicsTicksPerSecond) / fixedFps,
          );
          const realizedInputTimeUs =
            requestedInput === undefined
              ? null
              : requestedInput.requested.requestedTick * deltaUs;
          const realizedClock = clock({
            processFrame: processFrames,
            physicsTick: physicsTicks,
            simulationTimeUs: processFrames * deltaUs,
          });
          const inputReceipt =
            requestedInput === undefined
              ? []
              : [
                  {
                    schemaVersion: 1,
                    requestId: requestedInput.requestId,
                    requested: requestedInput.requested,
                    realized: {
                      ...clock({
                        processFrame: requestedInput.requested.requestedTick,
                        physicsTick: Math.floor(
                          (requestedInput.requested.requestedTick *
                            physicsTicksPerSecond) /
                            fixedFps,
                        ),
                        simulationTimeUs: realizedInputTimeUs!,
                      }),
                      phase: "process_frame_start",
                      quantized: false,
                      mismatchReason: null,
                    },
                    knownSideEffects: ["managed press/release pulse"],
                  },
                ];
          const stepReceipts = Array.from(
            { length: processFrames },
            (_, index) => {
              const physicsBefore = Math.floor(
                (index * physicsTicksPerSecond) / fixedFps,
              );
              const physicsThrough = Math.floor(
                ((index + 1) * physicsTicksPerSecond) / fixedFps,
              );
              const physicsExecuted = physicsThrough - physicsBefore;
              const appliesInput =
                requestedInput?.requested.requestedTick === index;
              return {
                requestedTick: index,
                realizedTick: index,
                requestedDeltaUs: deltaUs,
                realizedDeltaUs: deltaUs,
                appliedInputOrders: appliesInput ? [0] : [],
                runtime: {
                  schemaVersion: 1,
                  phase: "process_frame_start",
                  idleFramesExecuted: 1,
                  physicsTicksExecuted: physicsExecuted,
                  actualIdleDeltasUs: [deltaUs],
                  actualPhysicsDeltasUs: Array.from(
                    { length: physicsExecuted },
                    () => Math.round(1_000_000 / physicsTicksPerSecond),
                  ),
                  engineProcessFrame: index + 1,
                  enginePhysicsFrame: physicsThrough,
                  hostMonotonicStartUs: index * 2 + 1,
                  hostMonotonicEndUs: index * 2 + 2,
                  inputApplications: appliesInput
                    ? [
                        {
                          order: 0,
                          eventsInjected: 2,
                          pressed: true,
                          released: true,
                        },
                      ]
                    : [],
                  observationHealth: {
                    schemaVersion: 1,
                    emittedEvents: 1,
                    droppedEvents: index === 0 ? (options.lossCount ?? 0) : 0,
                    truncatedEvents: 0,
                    bufferedBytes: 12,
                    backpressure: false,
                    probeOverheadUs: 0,
                  },
                },
              };
            },
          );
          return Promise.resolve(
            success(request, {
              runtimeId,
              executionId,
              requested: { clock: "process_frame", count: processFrames },
              realized: {
                processFrames,
                physicsTicks,
                requestedClockProgress: processFrames,
                overshoot: 0,
              },
              state: {
                values: { "player.jumping": options.jumping ?? true },
              },
              clocks: realizedClock,
              receipts: inputReceipt,
              stepReceipts,
              pendingInputs: [],
              ...captureEvidence(processFrames),
            }),
          );
        }
        case GAME_TOOL_NAMES_V1.stop:
          return Promise.resolve(
            success(request, {
              ...runtimeFacts(options.stopStatus ?? "stopped", 14),
              sealed: true,
            }),
          );
        case GAME_TOOL_NAMES_V1.query: {
          const queryInput = request.input as {
            executionId: string;
            indexId?: string;
            limit: number;
            cursor?: string;
          };
          const position = clock({
            processFrame: 14,
            physicsTick: Math.floor((14 * physicsTicksPerSecond) / fixedFps),
            simulationTimeUs: 14 * Math.round(1_000_000 / fixedFps),
          });
          const rows =
            options.protocolError === undefined
              ? []
              : [
                  {
                    schemaVersion: 1,
                    rawEventId: `event:error:${options.taskId}`,
                    rawSequence: 0,
                    clock: position,
                    kind: "error",
                    entity: null,
                    statePath: null,
                    value: { message: options.protocolError },
                    observedRelations: [],
                    checkpointId: null,
                  },
                ];
          const evidence = captureEvidence(14);
          return Promise.resolve(
            success(request, {
              result: {
                schemaVersion: 1,
                taskId: options.taskId,
                indexId:
                  queryInput.indexId ?? `runtime-state-index:${options.taskId}`,
                executionId,
                runtimeId,
                sourceId,
                buildId,
                adapterId,
                probeIds: [],
                captureWindowIds: [],
                rawRecordHash: asSha256DigestV1("9".repeat(64)),
                query: {
                  schemaVersion: 1,
                  taskId: options.taskId,
                  executionId: queryInput.executionId,
                  entityIds: [],
                  eventKinds: rows.length === 0 ? [] : ["error"],
                  statePaths: [],
                  clockRange: null,
                  limit: queryInput.limit,
                  cursor: queryInput.cursor ?? null,
                },
                rows,
                ...evidence,
                incomplete:
                  options.queryIncomplete === true ||
                  evidence.loss.length > 0 ||
                  evidence.coverage.some((entry) => entry.status !== "full"),
                nextCursor: null,
              },
            }),
          );
        }
        default:
          throw new Error(`unexpected tool ${request.toolName}`);
      }
    },
  };
  return { port, calls, runtimeId, executionId, buildId };
};

describe("frame-input-window game-tool scenario runner", () => {
  it("retries evaluator cleanup and releases process-local ownership only after proof", async () => {
    const ownership = { taskId: "task:evaluator-cleanup-retry" };
    const activeOwnerships = new Set([ownership]);
    let attempts = 0;

    await cleanupFrameInputWindowEvaluatorOwnershipV1({
      ownership,
      activeOwnerships,
      cleanup: () => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(new Error("cleanup proof unavailable"));
        }
        return Promise.resolve({
          processGroupTerminated: true,
          cgroupPopulated: false,
          scopeRemoved: true,
        });
      },
    });

    expect(attempts).toBe(2);
    expect(activeOwnerships.has(ownership)).toBe(false);
  });

  it("retains evaluator ownership and temporary-root evidence when cleanup stays unproven", async () => {
    const ownership = { taskId: "task:evaluator-cleanup-retained" };
    const activeOwnerships = new Set([ownership]);
    let attempts = 0;
    let temporaryRootEvidencePresent = true;

    await expect(
      cleanupFrameInputWindowReleaseRootV1({
        activeEvaluatorOwnerships: activeOwnerships,
        cleanupEvaluator: () => {
          attempts += 1;
          return Promise.resolve({
            processGroupTerminated: false,
            cgroupPopulated: true,
            scopeRemoved: false,
          });
        },
        removeTemporaryRoot: () => {
          temporaryRootEvidencePresent = false;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(/temporary root was retained/u);

    expect(attempts).toBe(2);
    expect(activeOwnerships.has(ownership)).toBe(true);
    expect(temporaryRootEvidencePresent).toBe(true);
  });

  it("retains setup-cleanup ownership and temporary-root evidence until retry proves release", async () => {
    const ownership = { setup: "retained" };
    const activeRetainedCleanupOwnerships = new Set([ownership]);
    let attempts = 0;
    let temporaryRootEvidencePresent = true;

    await expect(
      cleanupFrameInputWindowReleaseRootV1({
        activeEvaluatorOwnerships: new Set(),
        cleanupEvaluator: () =>
          Promise.resolve({
            processGroupTerminated: true,
            cgroupPopulated: false,
            scopeRemoved: true,
          }),
        activeRetainedCleanupOwnerships,
        cleanupRetainedOwnership: () => {
          attempts += 1;
          return Promise.reject(new Error("setup owner remains live"));
        },
        removeTemporaryRoot: () => {
          temporaryRootEvidencePresent = false;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(/temporary root was retained/u);

    expect(attempts).toBe(2);
    expect(activeRetainedCleanupOwnerships.has(ownership)).toBe(true);
    expect(temporaryRootEvidencePresent).toBe(true);
  });

  it("quantizes 75ms and 250ms to the first process tick at or after the requested time", () => {
    expect(frameInputWindowProcessTickV1(75_000, 120)).toEqual({
      deltaUs: 8_333,
      requestedTick: 10,
    });
    expect(frameInputWindowProcessTickV1(75_000, 60)).toEqual({
      deltaUs: 16_667,
      requestedTick: 5,
    });
    expect(frameInputWindowProcessTickV1(250_000, 120)).toEqual({
      deltaUs: 8_333,
      requestedTick: 31,
    });
    expect(frameInputWindowProcessTickV1(250_000, 60)).toEqual({
      deltaUs: 16_667,
      requestedTick: 15,
    });
  });

  it("uses capabilities, a fresh controlled launch, input receipt, step clocks, and a sealed stop", async () => {
    const taskId = asTaskId("task:evaluator-1");
    const fake = createFakeTask({ taskId, sourceHash: candidateHash });
    let closed = 0;
    const factory: FrameInputWindowEvaluatorTaskFactoryV1 = {
      create: () =>
        Promise.resolve({
          taskId,
          port: fake.port,
          close: () => {
            closed += 1;
            return Promise.resolve();
          },
        }),
    };
    const result = await createFrameInputWindowGameToolScenarioRunnerV1({
      factory,
    }).run(scenario());

    expect(fake.calls.map((call) => call.toolName)).toEqual([
      "game_capabilities",
      "game_launch",
      "game_input",
      "game_step",
      "game_stop",
      "game_query",
    ]);
    expect(fake.calls[1]?.input).toMatchObject({
      schemaVersion: 1,
      taskId,
      buildId: fake.buildId,
      controls: {
        fixedFps: 120,
        physicsTicksPerSecond: 60,
        maxTicks: 64,
      },
    });
    expect(fake.calls[2]?.input).toMatchObject({
      requested: {
        clock: "process_frame",
        requestedTick: 10,
        requestedPhase: "process_frame_start",
      },
    });
    expect(result).toMatchObject({
      scenarioId: scenario().scenarioId,
      sourceHash: candidateHash,
      realizedFixedFps: 120,
      realizedPhysicsTicksPerSecond: 60,
      requestedInputTimeUs: 75_000,
      realizedInputTimeUs: 83_330,
      jumping: true,
      runtimeStatus: "completed",
      protocolErrors: [],
      droppedEventCount: 0,
      observationComplete: true,
    });
    expect(result.processFrames).toBeGreaterThan(10);
    expect(closed).toBe(1);
  });

  it("does not inject input for the negative control and still observes beyond 250ms", async () => {
    const taskId = asTaskId("task:evaluator-no-input");
    const fake = createFakeTask({
      taskId,
      sourceHash: candidateHash,
      jumping: false,
    });
    const result = await createFrameInputWindowGameToolScenarioRunnerV1({
      factory: {
        create: () =>
          Promise.resolve({
            taskId,
            port: fake.port,
            close: () => Promise.resolve(),
          }),
      },
    }).run(
      scenario({
        scenarioId: "frame-input-window:111111111111111111111111",
        fixedFps: 60,
        physicsTicksPerSecond: 120,
        inputTimeUs: null,
        expectedJumping: false,
      }),
    );

    expect(fake.calls.map((call) => call.toolName)).not.toContain("game_input");
    expect(
      fake.calls.find((call) => call.toolName === "game_step")?.input,
    ).toMatchObject({ count: 17 });
    expect(result).toMatchObject({
      requestedInputTimeUs: null,
      realizedInputTimeUs: null,
      jumping: false,
    });
  });

  it("counts raw capture loss and Godot observation-health loss", async () => {
    const taskId = asTaskId("task:evaluator-loss");
    const fake = createFakeTask({
      taskId,
      sourceHash: candidateHash,
      lossCount: 3,
    });
    const result = await createFrameInputWindowGameToolScenarioRunnerV1({
      factory: {
        create: () =>
          Promise.resolve({
            taskId,
            port: fake.port,
            close: () => Promise.resolve(),
          }),
      },
    }).run(scenario());
    expect(result.droppedEventCount).toBe(3);
    expect(result.observationComplete).toBe(false);
  });

  it("observes sealed runtime error rows instead of fabricating an empty protocol-error list", async () => {
    const taskId = asTaskId("task:evaluator-protocol-error");
    const fake = createFakeTask({
      taskId,
      sourceHash: candidateHash,
      protocolError: "sidecar reported a protocol failure",
    });
    const result = await createFrameInputWindowGameToolScenarioRunnerV1({
      factory: {
        create: () =>
          Promise.resolve({
            taskId,
            port: fake.port,
            close: () => Promise.resolve(),
          }),
      },
    }).run(scenario());

    expect(result.protocolErrors).toEqual([
      `runtime error event event:error:${taskId}`,
    ]);
    expect(fake.calls.map((call) => call.toolName)).toContain("game_query");
  });

  it("marks zero-count sampled or terminal-incomplete capture evidence as incomplete", async () => {
    for (const [suffix, options] of [
      ["sampled", { coverageStatus: "sampled", lossKind: "sampled" }],
      ["query", { queryIncomplete: true }],
    ] as const) {
      const taskId = asTaskId(`task:evaluator-incomplete-${suffix}`);
      const fake = createFakeTask({
        taskId,
        sourceHash: candidateHash,
        ...options,
      });
      const result = await createFrameInputWindowGameToolScenarioRunnerV1({
        factory: {
          create: () =>
            Promise.resolve({
              taskId,
              port: fake.port,
              close: () => Promise.resolve(),
            }),
        },
      }).run(scenario());
      expect(result.droppedEventCount).toBe(0);
      expect(result.observationComplete).toBe(false);
    }
  });

  it("reports candidate launch/step runtime failures only after Task cleanup is proven", async () => {
    for (const testCase of [
      {
        taskId: asTaskId("task:evaluator-candidate-launch-crashed"),
        errorTool: GAME_TOOL_NAMES_V1.launch,
        errorCode: "runtime_crashed" as const,
        expectedStage: "launch" as const,
      },
      {
        taskId: asTaskId("task:evaluator-candidate-launch-unavailable"),
        errorTool: GAME_TOOL_NAMES_V1.launch,
        errorCode: "runtime_unavailable" as const,
        expectedStage: "launch" as const,
      },
      {
        taskId: asTaskId("task:evaluator-candidate-step-unavailable"),
        errorTool: GAME_TOOL_NAMES_V1.step,
        errorCode: "runtime_unavailable" as const,
        expectedStage: "step" as const,
      },
      {
        taskId: asTaskId("task:evaluator-candidate-step-operation-failed"),
        errorTool: GAME_TOOL_NAMES_V1.step,
        errorCode: "operation_failed" as const,
        expectedStage: "step" as const,
      },
    ]) {
      const fake = createFakeTask({
        taskId: testCase.taskId,
        sourceHash: candidateHash,
        errorTool: testCase.errorTool,
        errorCode: testCase.errorCode,
        errorDetails: {
          schemaVersion: 1,
          attribution: "candidate_source",
          stage: testCase.expectedStage,
          sourceHash: candidateHash,
        },
      });
      let closed = 0;
      let failure: unknown;
      try {
        await createFrameInputWindowGameToolScenarioRunnerV1({
          factory: {
            create: () =>
              Promise.resolve({
                taskId: testCase.taskId,
                port: fake.port,
                close: () => {
                  closed += 1;
                  return Promise.resolve();
                },
              }),
          },
        }).run(scenario());
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(FrameInputWindowCandidateExecutionError);
      if (!(failure instanceof FrameInputWindowCandidateExecutionError)) {
        throw new Error("expected a candidate execution failure");
      }
      expect(failure.evidence).toEqual({
        schemaVersion: 1,
        scenarioId: "frame-input-window:0123456789abcdef01234567",
        stage: testCase.expectedStage,
        toolName:
          testCase.expectedStage === "launch" ? "game_launch" : "game_step",
        error: {
          code: testCase.errorCode,
          message: "delegated runtime failed",
        },
        expectedSourceHash: candidateHash,
        requestedControls: {
          fixedFps: 120,
          physicsTicksPerSecond: 60,
          maxTicks: 64,
          inputTimeUs: 75_000,
        },
        cleanupProven: true,
      });
      expect(failure.evidence).not.toHaveProperty("observation");
      expect(closed).toBe(1);
    }
  });

  it("treats a sealed failed runtime as cleanup proof only for an already source-bound candidate failure", async () => {
    const candidateTaskId = asTaskId(
      "task:evaluator-candidate-failed-runtime-sealed",
    );
    const candidate = createFakeTask({
      taskId: candidateTaskId,
      sourceHash: candidateHash,
      errorTool: GAME_TOOL_NAMES_V1.step,
      errorCode: "runtime_crashed",
      errorDetails: {
        schemaVersion: 1,
        attribution: "candidate_source",
        stage: "step",
        sourceHash: candidateHash,
      },
      stopStatus: "failed",
    });
    await expect(
      createFrameInputWindowGameToolScenarioRunnerV1({
        factory: {
          create: () =>
            Promise.resolve({
              taskId: candidateTaskId,
              port: candidate.port,
              close: () => Promise.resolve(),
            }),
        },
      }).run(scenario()),
    ).rejects.toMatchObject({
      name: "FrameInputWindowCandidateExecutionError",
      evidence: {
        stage: "step",
        expectedSourceHash: candidateHash,
        cleanupProven: true,
      },
    });
    expect(candidate.calls.at(-1)?.toolName).toBe(GAME_TOOL_NAMES_V1.stop);

    const evaluatorTaskId = asTaskId(
      "task:evaluator-unexpected-failed-runtime-sealed",
    );
    const evaluator = createFakeTask({
      taskId: evaluatorTaskId,
      sourceHash: candidateHash,
      stopStatus: "failed",
    });
    await expect(
      createFrameInputWindowGameToolScenarioRunnerV1({
        factory: {
          create: () =>
            Promise.resolve({
              taskId: evaluatorTaskId,
              port: evaluator.port,
              close: () => Promise.resolve(),
            }),
        },
      }).run(scenario()),
    ).rejects.toMatchObject({
      name: "FrameInputWindowRunnerInfrastructureError",
      infrastructureCode: "runtime_cleanup_failed",
    });
  });

  it("requires exact source-and-stage proof for every candidate runtime failure code", async () => {
    const attributedTaskId = asTaskId(
      "task:evaluator-candidate-launch-attributed",
    );
    const attributed = createFakeTask({
      taskId: attributedTaskId,
      sourceHash: candidateHash,
      errorTool: GAME_TOOL_NAMES_V1.launch,
      errorCode: "operation_failed",
      errorDetails: {
        schemaVersion: 1,
        attribution: "candidate_source",
        stage: "launch",
        sourceHash: candidateHash,
      },
    });
    await expect(
      createFrameInputWindowGameToolScenarioRunnerV1({
        factory: {
          create: () =>
            Promise.resolve({
              taskId: attributedTaskId,
              port: attributed.port,
              close: () => Promise.resolve(),
            }),
        },
      }).run(scenario()),
    ).rejects.toBeInstanceOf(FrameInputWindowCandidateExecutionError);

    for (const [index, testCase] of [
      {
        errorCode: "runtime_crashed" as const,
        errorDetails: undefined,
      },
      {
        errorCode: "runtime_unavailable" as const,
        errorDetails: {
          schemaVersion: 1,
          attribution: "candidate_source",
          stage: "launch",
          sourceHash: baselineHash,
        },
      },
      {
        errorCode: "operation_failed" as const,
        errorDetails: {
          schemaVersion: 1,
          attribution: "candidate_source",
          stage: "step",
          sourceHash: candidateHash,
        },
      },
      {
        errorCode: "runtime_crashed" as const,
        errorDetails: {
          schemaVersion: 1,
          attribution: "candidate_source",
          stage: "launch",
          sourceHash: candidateHash,
          cleanup: "claimed-by-untrusted-details",
        },
      },
    ].entries()) {
      const taskId = asTaskId(
        `task:evaluator-host-launch-invalid-proof-${index}`,
      );
      const fake = createFakeTask({
        taskId,
        sourceHash: candidateHash,
        errorTool: GAME_TOOL_NAMES_V1.launch,
        errorCode: testCase.errorCode,
        ...(testCase.errorDetails === undefined
          ? {}
          : { errorDetails: testCase.errorDetails }),
      });
      await expect(
        createFrameInputWindowGameToolScenarioRunnerV1({
          factory: {
            create: () =>
              Promise.resolve({
                taskId,
                port: fake.port,
                close: () => Promise.resolve(),
              }),
          },
        }).run(scenario()),
      ).rejects.toMatchObject({
        name: "FrameInputWindowRunnerInfrastructureError",
        infrastructureCode: "tool_operation_failed",
      });
    }
  });

  it("keeps baseline, factory, tool-protocol, and cleanup failures as infrastructure", async () => {
    await expect(
      createFrameInputWindowGameToolScenarioRunnerV1({
        factory: {
          create: () => Promise.reject(new Error("sandbox factory failed")),
        },
      }).run(scenario()),
    ).rejects.toMatchObject({
      name: "FrameInputWindowRunnerInfrastructureError",
      infrastructureCode: "factory_failed",
    });

    const baselineTaskId = asTaskId("task:evaluator-baseline-runtime-error");
    const baseline = createFakeTask({
      taskId: baselineTaskId,
      sourceHash: baselineHash,
      errorTool: GAME_TOOL_NAMES_V1.step,
    });
    await expect(
      createFrameInputWindowGameToolScenarioRunnerV1({
        factory: {
          create: () =>
            Promise.resolve({
              taskId: baselineTaskId,
              port: baseline.port,
              close: () => Promise.resolve(),
            }),
        },
      }).run(
        scenario({
          subject: "baseline",
          expectedSourceHash: baselineHash,
          expectedJumping: false,
        }),
      ),
    ).rejects.toBeInstanceOf(FrameInputWindowRunnerInfrastructureError);

    const corruptTaskId = asTaskId("task:evaluator-corrupt-step");
    const corrupt = createFakeTask({
      taskId: corruptTaskId,
      sourceHash: candidateHash,
      corruptStepOutput: true,
    });
    await expect(
      createFrameInputWindowGameToolScenarioRunnerV1({
        factory: {
          create: () =>
            Promise.resolve({
              taskId: corruptTaskId,
              port: corrupt.port,
              close: () => Promise.resolve(),
            }),
        },
      }).run(scenario()),
    ).rejects.toMatchObject({
      name: "FrameInputWindowRunnerInfrastructureError",
      infrastructureCode: "tool_protocol_failed",
    });

    const cleanupTaskId = asTaskId("task:evaluator-cleanup-unproven");
    const cleanup = createFakeTask({
      taskId: cleanupTaskId,
      sourceHash: candidateHash,
      errorTool: GAME_TOOL_NAMES_V1.step,
      errorCode: "runtime_crashed",
      errorDetails: {
        schemaVersion: 1,
        attribution: "candidate_source",
        stage: "step",
        sourceHash: candidateHash,
      },
    });
    await expect(
      createFrameInputWindowGameToolScenarioRunnerV1({
        factory: {
          create: () =>
            Promise.resolve({
              taskId: cleanupTaskId,
              port: cleanup.port,
              close: () => Promise.reject(new Error("cgroup still populated")),
            }),
        },
      }).run(scenario()),
    ).rejects.toMatchObject({
      name: "FrameInputWindowRunnerInfrastructureError",
      infrastructureCode: "runtime_cleanup_failed",
    });

    const stopCleanupTaskId = asTaskId(
      "task:evaluator-candidate-stop-cleanup-unproven",
    );
    const stopCleanup = createFakeTask({
      taskId: stopCleanupTaskId,
      sourceHash: candidateHash,
      errorTool: GAME_TOOL_NAMES_V1.step,
      errorCode: "runtime_crashed",
      errorDetails: {
        schemaVersion: 1,
        attribution: "candidate_source",
        stage: "step",
        sourceHash: candidateHash,
      },
      stopError: true,
    });
    await expect(
      createFrameInputWindowGameToolScenarioRunnerV1({
        factory: {
          create: () =>
            Promise.resolve({
              taskId: stopCleanupTaskId,
              port: stopCleanup.port,
              close: () => Promise.resolve(),
            }),
        },
      }).run(scenario()),
    ).rejects.toMatchObject({
      name: "FrameInputWindowRunnerInfrastructureError",
      infrastructureCode: "runtime_cleanup_failed",
    });

    const mainAndStopTaskId = asTaskId(
      "task:evaluator-main-and-stop-cleanup-fail",
    );
    const mainAndStop = createFakeTask({
      taskId: mainAndStopTaskId,
      sourceHash: candidateHash,
      corruptStepOutput: true,
      stopError: true,
    });
    await expect(
      createFrameInputWindowGameToolScenarioRunnerV1({
        factory: {
          create: () =>
            Promise.resolve({
              taskId: mainAndStopTaskId,
              port: mainAndStop.port,
              close: () => Promise.resolve(),
            }),
        },
      }).run(scenario()),
    ).rejects.toMatchObject({
      name: "FrameInputWindowRunnerInfrastructureError",
      infrastructureCode: "runtime_cleanup_failed",
    });
  });

  it("prioritizes invalid/reused namespace cleanup failure over the validation error", async () => {
    const validTaskId = asTaskId("task:evaluator-close-validation");
    const fake = createFakeTask({
      taskId: validTaskId,
      sourceHash: candidateHash,
    });
    const invalidRunner = createFrameInputWindowGameToolScenarioRunnerV1({
      factory: {
        create: () =>
          Promise.resolve({
            taskId: "../invalid" as ReturnType<typeof asTaskId>,
            port: fake.port,
            close: () => Promise.reject(new Error("invalid task orphaned")),
          }),
      },
    });
    await expect(invalidRunner.run(scenario())).rejects.toMatchObject({
      infrastructureCode: "runtime_cleanup_failed",
    });

    let creates = 0;
    const reusedRunner = createFrameInputWindowGameToolScenarioRunnerV1({
      factory: {
        create: () => {
          creates += 1;
          return Promise.resolve({
            taskId: validTaskId,
            port: fake.port,
            close: () =>
              creates === 1
                ? Promise.resolve()
                : Promise.reject(new Error("reused task orphaned")),
          });
        },
      },
    });
    await reusedRunner.run(scenario());
    await expect(
      reusedRunner.run(
        scenario({
          scenarioId: "frame-input-window:333333333333333333333333",
        }),
      ),
    ).rejects.toMatchObject({ infrastructureCode: "runtime_cleanup_failed" });
  });

  it("retains the temporary root when partial product start leaves cleanup uncertain", async () => {
    let removed = false;
    await expect(
      cleanupFrameInputWindowReleaseRootV1({
        activeEvaluatorOwnerships: new Set(),
        cleanupEvaluator: () =>
          Promise.resolve({
            processGroupTerminated: true,
            cgroupPopulated: false,
            scopeRemoved: true,
          }),
        cleanupProductTask: () =>
          Promise.reject(new Error("partial start ownership unavailable")),
        removeTemporaryRoot: () => {
          removed = true;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(/temporary root was retained/u);
    expect(removed).toBe(false);
  });

  it("rejects source drift and reuse of an evaluator Task namespace", async () => {
    const taskId = asTaskId("task:evaluator-reused");
    const fake = createFakeTask({ taskId, sourceHash: baselineHash });
    const runner = createFrameInputWindowGameToolScenarioRunnerV1({
      factory: {
        create: () =>
          Promise.resolve({
            taskId,
            port: fake.port,
            close: () => Promise.resolve(),
          }),
      },
    });
    await expect(runner.run(scenario())).rejects.toThrow(/source identity/u);
    await expect(
      runner.run(
        scenario({
          scenarioId: "frame-input-window:222222222222222222222222",
        }),
      ),
    ).rejects.toThrow(/reused evaluator Task/u);
  });
});
