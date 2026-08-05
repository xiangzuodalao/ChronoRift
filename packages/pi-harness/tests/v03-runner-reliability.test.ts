import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FailureBriefV1Schema,
  V03ExecutionLogSchema,
  asBranchId,
  asCapsuleId,
  asCheckpointId,
  asContractId,
  asEventId,
  asExecutionId,
  asFixtureId,
  asInputTraceId,
  asInterventionId,
  asRunId,
  type BenchmarkArmV1,
  type CapsuleId,
  type EvidenceCapsuleV2,
  type ExecutionId,
  type ExperimentCandidateV1,
  type InterventionId,
  type V03ExecutionComparison,
  type V03ExecutionLog,
} from "@chronorift/domain";
import {
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { PiHarnessError, PiProviderFailureError } from "../src/errors.js";
import {
  V03ToolFlow,
  createV03Tools,
  runV03PiDiagnosisWithRuntime,
} from "../src/internal/v03-runner.js";
import { createVirtualSourceAccess } from "../src/source-access.js";
import type {
  RestrictedSourceAccess,
  SourceReadResult,
  SourceSearchResult,
} from "../src/types.js";
import type {
  DeterministicV03PiHarnessOptions,
  V03AgentGameApi,
  V03ExperimentResult,
  V03PiPartialObservationV3,
  V03PiProgressSnapshotV3,
  V03ReplayResult,
} from "../src/v03-types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const root = async (): Promise<string> => {
  const value = await mkdtemp(join(tmpdir(), "chronorift-pi-v03-"));
  roots.push(value);
  return value;
};

const failureBrief = FailureBriefV1Schema.parse({
  schemaVersion: 1,
  runId: asRunId("run:v03-reliability"),
  fixtureId: asFixtureId("fixture:v03-reliability"),
  contractId: asContractId("contract:v03-reliability"),
  capsuleId: asCapsuleId("capsule:v03-reliability"),
  baselineExecutionId: asExecutionId("execution:v03-reliability"),
  trigger: { kind: "signal", source: "subject", name: "triggered" },
  triggerEventId: "event:v03-reliability",
  triggerTick: 0,
  expectation: {
    kind: "property_equals",
    path: "subject.result",
    value: true,
  },
  deadlineTick: 1,
  actual: { present: true, value: false },
  violationSummary: "The frozen expectation was not met",
});

const unavailableGame = {} as V03AgentGameApi;

const experimentId = asInterventionId("intervention:v03:reliability-shift");

const execution = (executionId: ExecutionId): V03ExecutionLog => {
  const branchId = asBranchId("branch:v03-reliability");
  const signalId = asEventId(`event:${executionId}:signal`);
  return V03ExecutionLogSchema.parse({
    schemaVersion: 2,
    executionId,
    runId: failureBrief.runId,
    fixtureId: failureBrief.fixtureId,
    branchId,
    contractId: failureBrief.contractId,
    startCheckpointId: asCheckpointId("checkpoint:v03-reliability"),
    inputTraceId: asInputTraceId("trace:v03-reliability"),
    status: "completed",
    evaluation: {
      status: "fail",
      triggerEventId: signalId,
      triggerTick: 0,
      deadlineTick: 1,
      observed: { present: true, value: false },
    },
    restoreReceipt: {
      requestedCheckpointId: asCheckpointId("checkpoint:v03-reliability"),
      restoredCheckpointId: asCheckpointId("checkpoint:v03-reliability"),
      restored: true,
      nextTick: 0,
      simTimeUs: 0,
      stateDigest: "b".repeat(64),
    },
    stepReceipts: [
      {
        requestedTick: 0,
        realizedTick: 0,
        requestedDeltaUs: 16_667,
        realizedDeltaUs: 16_667,
        appliedInputOrders: [],
      },
    ],
    controlReceipt: {
      schemaVersion: 1,
      requested: { fixed_fps: 60 },
      realized: { fixed_fps: 60 },
      accepted: true,
      mismatches: [],
    },
    observationHealth: {
      schemaVersion: 1,
      emittedEvents: 2,
      droppedEvents: 0,
      truncatedEvents: 0,
      bufferedBytes: 1,
      backpressure: false,
      probeOverheadUs: 0,
    },
    events: [
      {
        schemaVersion: 2,
        eventId: signalId,
        executionId,
        runId: failureBrief.runId,
        branchId,
        seq: 0,
        tick: 0,
        simTimeUs: 0,
        kind: "signal",
        source: "subject",
        name: "triggered",
        arguments: [],
      },
      {
        schemaVersion: 2,
        eventId: asEventId(`event:${executionId}:delivery`),
        executionId,
        runId: failureBrief.runId,
        branchId,
        seq: 1,
        tick: 0,
        simTimeUs: 0,
        causedByEventId: signalId,
        kind: "signal_delivery",
        source: "subject",
        name: "triggered",
        receiver: "receiver",
        delivered: false,
        failureReason: "receiver_not_connected",
      },
    ],
    finalState: { values: { "subject.result": false } },
    timelineDigest: "a".repeat(64),
    sealed: true,
  });
};

class ScopedExperimentGame implements V03AgentGameApi {
  public readonly baselineExecutions = 1;
  public diagnosticExecutions = 0;
  public runExperimentCalls = 0;
  private readonly baseline = execution(failureBrief.baselineExecutionId);

  public getEvidenceCapsule(
    _capsuleId: CapsuleId,
  ): Promise<EvidenceCapsuleV2 | null> {
    void _capsuleId;
    return Promise.resolve(null);
  }

  public getRawBaseline(_executionId: ExecutionId): Promise<unknown> {
    void _executionId;
    return Promise.resolve({ schemaVersion: 1, execution: this.baseline });
  }

  public replayExecution(_executionId: ExecutionId): Promise<V03ReplayResult> {
    void _executionId;
    this.diagnosticExecutions += 1;
    return Promise.resolve({
      execution: execution(asExecutionId("execution:v03-reliability-replay")),
      matches: true,
      sourceDigest: this.baseline.timelineDigest,
      replayDigest: this.baseline.timelineDigest,
    });
  }

  public listExperiments(): Promise<readonly ExperimentCandidateV1[]> {
    return Promise.resolve([
      {
        schemaVersion: 1,
        interventionId: experimentId,
        label: "Shift input by one logical tick",
        intervention: { kind: "shift_input", inputOrder: 0, deltaTicks: 1 },
      },
    ]);
  }

  public runExperiment(
    _baselineExecutionId: ExecutionId,
    _interventionId: InterventionId,
  ): Promise<V03ExperimentResult> {
    void _baselineExecutionId;
    void _interventionId;
    this.runExperimentCalls += 1;
    return Promise.reject(new Error("Out-of-scope experiment reached game"));
  }

  public compareExecutions(
    _baselineExecutionId: ExecutionId,
    _candidateExecutionId: ExecutionId,
  ): Promise<V03ExecutionComparison> {
    void _baselineExecutionId;
    void _candidateExecutionId;
    return Promise.reject(new Error("Comparison is unavailable"));
  }
}

const options = (
  cwd: string,
  source: RestrictedSourceAccess,
  extra: Partial<DeterministicV03PiHarnessOptions> = {},
): DeterministicV03PiHarnessOptions => ({
  cwd,
  runDir: join(cwd, "run"),
  arm: "generic",
  initialCapsuleId: failureBrief.capsuleId,
  baselineExecutionId: failureBrief.baselineExecutionId,
  game: unavailableGame,
  source,
  failureBrief,
  thinkingLevel: "off",
  sdkRetry: false,
  timeoutMs: 5_000,
  ...extra,
});

const runtime = async (responses: readonly FauxResponseStep[]) => {
  const faux = fauxProvider({
    api: "chronorift-v03-reliability-api",
    provider: "chronorift-v03-reliability",
    models: [{ id: "reliability", input: ["text"], maxTokens: 8_192 }],
    tokenSize: { min: 4, max: 4 },
  });
  faux.setResponses([...responses]);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = modelRuntime.getModel(
    "chronorift-v03-reliability",
    "reliability",
  );
  if (!model) throw new Error("Reliability faux model was not registered");
  return { faux, modelRuntime, model };
};

describe("V03 Pi runner reliability", () => {
  it.each(["generic", "evidence-only", "chronorift-full"] as const)(
    "marks every %s tool sequential",
    (arm: BenchmarkArmV1) => {
      const flow = new V03ToolFlow(
        options(
          "/virtual",
          createVirtualSourceAccess({
            files: [{ path: "case/main.gd", content: "extends Node" }],
          }),
          { arm },
        ),
      );

      const tools = createV03Tools(flow, arm);
      expect(tools.length).toBeGreaterThan(0);
      expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
      expect(tools.every((tool) => tool.executionMode === "sequential")).toBe(
        true,
      );
    },
  );

  it("preserves partial facts when a model corrupts the scoped baseline ID", async () => {
    const cwd = await root();
    const game = new ScopedExperimentGame();
    const corruptedBaselineId = "execution:v03-reliabilitx";
    const fake = await runtime([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "game_get_raw_baseline",
            { executionId: failureBrief.baselineExecutionId },
            { id: "raw-baseline" },
          ),
        ],
        { stopReason: "toolUse", timestamp: 1_735_689_600_001 },
      ),
      fauxAssistantMessage(
        [
          fauxToolCall(
            "game_replay_raw_baseline",
            { executionId: failureBrief.baselineExecutionId },
            { id: "raw-replay" },
          ),
        ],
        { stopReason: "toolUse", timestamp: 1_735_689_600_002 },
      ),
      fauxAssistantMessage(
        [fauxToolCall("game_list_experiments_v2", {}, { id: "catalog" })],
        { stopReason: "toolUse", timestamp: 1_735_689_600_003 },
      ),
      fauxAssistantMessage(
        [
          fauxToolCall(
            "game_run_experiment_v2",
            {
              baselineExecutionId: corruptedBaselineId,
              interventionId: experimentId,
            },
            { id: "corrupted-experiment" },
          ),
        ],
        { stopReason: "toolUse", timestamp: 1_735_689_600_004 },
      ),
    ]);
    const observations: V03PiPartialObservationV3[] = [];

    const failure = await runV03PiDiagnosisWithRuntime(
      options(
        cwd,
        createVirtualSourceAccess({
          files: [{ path: "case/main.gd", content: "extends Node" }],
        }),
        {
          game,
          onPartialObservationV3: (observation) => {
            observations.push(observation);
            return Promise.resolve();
          },
        },
      ),
      fake,
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "INVALID_TOOL_FLOW",
      message: "Experiment baseline is out of scope",
    });
    expect(game.runExperimentCalls).toBe(0);
    expect(game.diagnosticExecutions).toBe(1);
    expect(observations.at(-1)).toMatchObject({
      schemaVersion: 3,
      sessionPersisted: true,
      flow: {
        matchingReplay: true,
        interventionCount: 0,
        comparisonCount: 0,
      },
      progress: {
        tools: { started: 4, completed: 4, failed: 1, semanticRevision: 3 },
        game: { baselineExecutions: 1, diagnosticExecutions: 1 },
        proposalSubmitted: false,
      },
    });
    expect(
      observations.at(-1)?.accessReceipts.map((receipt) => receipt.accessKind),
    ).toEqual(["failure_brief", "raw_execution", "replay", "experiment"]);
  });

  it("aborts a multi-tool batch immediately on its first tool error", async () => {
    const cwd = await root();
    let readCalls = 0;
    let searchCalls = 0;
    const firstFailure = new PiHarnessError(
      "SOURCE_NOT_FOUND",
      "intentional first tool failure",
    );
    const source: RestrictedSourceAccess = {
      root: "/virtual",
      read: (): Promise<SourceReadResult> => {
        readCalls += 1;
        return Promise.reject(firstFailure);
      },
      search: (): Promise<SourceSearchResult> => {
        searchCalls += 1;
        return Promise.resolve({
          query: "never",
          matches: [],
          scannedFiles: 0,
          truncated: false,
        });
      },
    };
    const fake = await runtime([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "source_read_v1",
            { path: "missing.gd" },
            { id: "first-failing-tool" },
          ),
          fauxToolCall(
            "source_search_v1",
            { query: "never" },
            { id: "must-not-run" },
          ),
        ],
        { stopReason: "toolUse", timestamp: 1_735_689_600_000 },
      ),
    ]);
    const snapshots: V03PiProgressSnapshotV3[] = [];

    const failure = await runV03PiDiagnosisWithRuntime(
      options(cwd, source, {
        onProgressV3: async (snapshot) => {
          snapshots.push(snapshot);
          if (snapshot.tools.failed > 0) {
            throw new Error("later progress persistence failure");
          }
        },
      }),
      fake,
    ).catch((error: unknown) => error);

    expect(failure).toBe(firstFailure);
    expect(readCalls).toBe(1);
    expect(searchCalls).toBe(0);
    // Pi closes the Agent Loop with one signal-aborted continuation turn. The
    // important invariant is that no sibling tool executes after the failure.
    expect(fake.faux.state.callCount).toBe(2);
    expect(snapshots.some((snapshot) => snapshot.tools.failed === 1)).toBe(
      true,
    );
  });

  it("returns a typed connection failure instead of proposal_missing", async () => {
    const cwd = await root();
    const fake = await runtime([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "Connection error.",
        timestamp: 1_735_689_600_000,
      }),
    ]);
    const snapshots: V03PiProgressSnapshotV3[] = [];

    const failure = await runV03PiDiagnosisWithRuntime(
      options(
        cwd,
        createVirtualSourceAccess({
          files: [{ path: "case/main.gd", content: "extends Node" }],
        }),
        {
          onProgressV3: (snapshot) => {
            snapshots.push(snapshot);
            return Promise.resolve();
          },
        },
      ),
      fake,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PiProviderFailureError);
    expect(failure).toMatchObject({
      phase: "request",
      code: "connection",
      httpStatus: null,
      retryClass: "transient",
    });
    expect(snapshots.at(-1)).toMatchObject({
      schemaVersion: 3,
      fixtureStage: "fixture_validated",
      model: { requestStarted: true, outputObserved: false },
      tools: { started: 0, completed: 0, failed: 0, semanticRevision: 0 },
      game: { baselineExecutions: 1, diagnosticExecutions: 0 },
      proposalSubmitted: false,
    });
  });
});
