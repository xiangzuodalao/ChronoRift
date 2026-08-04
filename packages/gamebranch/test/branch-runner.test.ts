import {
  asBranchId,
  asCheckpointId,
  asEventId,
  asEvidenceId,
  asInputTraceId,
  asInvariantId,
  asRunId,
  type BranchId,
  type BranchRecord,
  type BranchRun,
  type Checkpoint,
  type CheckpointContent,
  type CheckpointId,
  type DiagnosisReport,
  type EnvironmentEventDraft,
  type EnvironmentRef,
  type EnvironmentSnapshot,
  type EvaluationId,
  type EvidenceBundle,
  type EvidenceId,
  type InputTrace,
  type InputTraceId,
  type InvariantEvaluation,
  type JsonObject,
  type JsonValue,
  type ReportId,
  type RunId,
  type RunManifest,
  type StateSnapshot,
  type TelemetryEvent,
  type TemporalInvariant,
} from "@chronorift/domain";
import { describe, expect, it } from "vitest";

import {
  BranchRunner,
  EvidenceCompiler,
  digestJson,
  type ArtifactRepositoryPort,
  type ClockPort,
  type FrameCommand,
  type FrameObservation,
  type GameEnvironmentFactoryPort,
  type GameEnvironmentPort,
  type IdGeneratorPort,
  type RestoreReceipt,
} from "../src/index.js";

const runId = asRunId("run-1");
const traceId = asInputTraceId("trace-1");
const environmentRef: EnvironmentRef = {
  adapter: "test-game",
  adapterVersion: "1",
  scene: "switch-door",
};
const invariant: TemporalInvariant = {
  schemaVersion: 1,
  invariantId: asInvariantId("door-opens-after-switch"),
  description: "Door must open after the switch activates",
  severity: "error",
  trigger: { kind: "signal", source: "/switch", name: "activated" },
  expectation: {
    kind: "property_equals",
    path: "/door/open",
    value: true,
  },
  withinTicks: 2,
  inclusive: true,
};

const initialSnapshot = (): EnvironmentSnapshot => ({
  state: {
    values: { "/switch/active": false, "/door/open": false },
  },
  runtimeState: {
    switchActive: false,
    doorOpen: false,
    openAtUs: null,
  },
  rngState: { seed: "test" },
  pendingEffects: [],
});

const getBoolean = (object: JsonObject, key: string): boolean => {
  const value = object[key];
  if (typeof value !== "boolean") throw new Error(`Expected ${key} boolean`);
  return value;
};

class TimingBugEnvironment implements GameEnvironmentPort {
  public readonly descriptor = environmentRef;
  private switchActive = false;
  private doorOpen = false;
  private openAtUs: number | null = null;

  public async restore(request: {
    readonly snapshot: EnvironmentSnapshot;
    readonly nextTick: number;
    readonly simTimeUs: number;
  }): Promise<RestoreReceipt> {
    const { snapshot } = request;
    if (
      snapshot.runtimeState === null ||
      Array.isArray(snapshot.runtimeState) ||
      typeof snapshot.runtimeState !== "object"
    ) {
      throw new Error("Invalid runtime state");
    }
    this.switchActive = getBoolean(snapshot.runtimeState, "switchActive");
    this.doorOpen = getBoolean(snapshot.runtimeState, "doorOpen");
    const openAtUs = snapshot.runtimeState.openAtUs;
    this.openAtUs = typeof openAtUs === "number" ? openAtUs : null;
    return {
      restored: true,
      nextTick: 0,
      simTimeUs: 0,
      state: this.state(),
    };
  }

  public async step(command: FrameCommand): Promise<FrameObservation> {
    const events: EnvironmentEventDraft[] = [];
    for (const input of command.inputs) {
      if (input.action !== "interact" || this.switchActive) continue;
      this.switchActive = true;
      this.openAtUs = command.simTimeUs + 32_000;
      events.push(
        {
          localId: `switch:${command.tick}`,
          causedByLocalId: input.localId,
          kind: "property_changed",
          path: "/switch/active",
          before: false,
          after: true,
        },
        {
          localId: `signal:${command.tick}`,
          causedByLocalId: `switch:${command.tick}`,
          kind: "signal",
          source: "/switch",
          name: "activated",
          arguments: [],
        },
        {
          localId: `schedule:${command.tick}`,
          causedByLocalId: `signal:${command.tick}`,
          kind: "log",
          level: "debug",
          source: "/door",
          message: "scheduled open",
          fields: { openAtUs: this.openAtUs },
        },
      );
    }

    const frameEndUs = command.simTimeUs + command.deltaUs;
    // Deliberate defect: a stepped clock can skip this exact value.
    if (
      !this.doorOpen &&
      this.openAtUs !== null &&
      frameEndUs === this.openAtUs
    ) {
      this.doorOpen = true;
      events.push({
        localId: `door:${command.tick}`,
        kind: "property_changed",
        path: "/door/open",
        before: false,
        after: true,
      });
    }
    return {
      events,
      state: this.state(),
      receipt: {
        requestedTick: command.tick,
        realizedTick: command.tick,
        requestedDeltaUs: command.deltaUs,
        realizedDeltaUs: command.deltaUs,
        appliedInputOrders: command.inputs.map((input) => input.order),
      },
    };
  }

  public async snapshot(): Promise<{ readonly snapshot: EnvironmentSnapshot }> {
    return {
      snapshot: {
        state: this.state(),
        runtimeState: {
          switchActive: this.switchActive,
          doorOpen: this.doorOpen,
          openAtUs: this.openAtUs,
        },
        rngState: { seed: "test" },
        pendingEffects: [],
      },
    };
  }

  public async dispose(): Promise<void> {}

  private state(): StateSnapshot {
    return {
      values: {
        "/switch/active": this.switchActive,
        "/door/open": this.doorOpen,
      },
    };
  }
}

class FakeEnvironmentFactory implements GameEnvironmentFactoryPort {
  public readonly instances: TimingBugEnvironment[] = [];

  public async create(): Promise<GameEnvironmentPort> {
    const environment = new TimingBugEnvironment();
    this.instances.push(environment);
    return environment;
  }
}

const missing = (kind: string, id: string): never => {
  throw new Error(`Missing ${kind}: ${id}`);
};

class MemoryRepository implements ArtifactRepositoryPort {
  public readonly checkpoints = new Map<CheckpointId, Checkpoint>();
  public readonly traces = new Map<InputTraceId, InputTrace>();
  public readonly branches = new Map<BranchId, BranchRecord>();
  public readonly branchRuns = new Map<BranchId, BranchRun>();
  public readonly telemetry = new Map<BranchId, TelemetryEvent[]>();
  public readonly evaluations = new Map<EvaluationId, InvariantEvaluation>();
  public readonly evidence = new Map<EvidenceId, EvidenceBundle>();
  public readonly manifests = new Map<RunId, RunManifest>();
  public readonly diagnoses = new Map<ReportId, DiagnosisReport>();

  public async putCheckpoint(content: CheckpointContent): Promise<Checkpoint> {
    const checkpointId = asCheckpointId(
      digestJson(content as unknown as JsonValue),
    );
    const checkpoint = { checkpointId, content };
    this.checkpoints.set(checkpointId, checkpoint);
    return checkpoint;
  }

  public async getCheckpoint(checkpointId: CheckpointId): Promise<Checkpoint> {
    return (
      this.checkpoints.get(checkpointId) ?? missing("checkpoint", checkpointId)
    );
  }

  public async putInputTrace(trace: InputTrace): Promise<void> {
    this.traces.set(trace.inputTraceId, trace);
  }

  public async getInputTrace(inputTraceId: InputTraceId): Promise<InputTrace> {
    return this.traces.get(inputTraceId) ?? missing("trace", inputTraceId);
  }

  public async putBranch(branch: BranchRecord): Promise<void> {
    this.branches.set(branch.branchId, branch);
  }

  public async getBranch(branchId: BranchId): Promise<BranchRecord> {
    return this.branches.get(branchId) ?? missing("branch", branchId);
  }

  public async appendTelemetry(
    branchId: BranchId,
    events: readonly TelemetryEvent[],
  ): Promise<void> {
    this.telemetry.set(branchId, [
      ...(this.telemetry.get(branchId) ?? []),
      ...events,
    ]);
  }

  public async putBranchRun(run: BranchRun): Promise<void> {
    this.branchRuns.set(run.branchId, run);
  }

  public async getBranchRun(branchId: BranchId): Promise<BranchRun> {
    return this.branchRuns.get(branchId) ?? missing("branch run", branchId);
  }

  public async putEvaluation(evaluation: InvariantEvaluation): Promise<void> {
    this.evaluations.set(evaluation.evaluationId, evaluation);
  }

  public async getEvaluation(id: EvaluationId): Promise<InvariantEvaluation> {
    return this.evaluations.get(id) ?? missing("evaluation", id);
  }

  public async putEvidence(evidence: EvidenceBundle): Promise<void> {
    this.evidence.set(evidence.evidenceId, evidence);
  }

  public async getEvidence(id: EvidenceId): Promise<EvidenceBundle> {
    return this.evidence.get(id) ?? missing("evidence", id);
  }

  public async putManifest(
    manifest: RunManifest,
    expectedRevision: number | null,
  ): Promise<void> {
    const existing = this.manifests.get(manifest.runId);
    if (
      (existing === undefined && expectedRevision !== null) ||
      (existing !== undefined && existing.revision !== expectedRevision)
    ) {
      throw new Error("Manifest revision conflict");
    }
    this.manifests.set(manifest.runId, manifest);
  }

  public async getManifest(id: RunId): Promise<RunManifest> {
    return this.manifests.get(id) ?? missing("manifest", id);
  }

  public async putDiagnosis(report: DiagnosisReport): Promise<void> {
    this.diagnoses.set(report.reportId, report);
  }

  public async getDiagnosis(id: ReportId): Promise<DiagnosisReport> {
    return this.diagnoses.get(id) ?? missing("diagnosis", id);
  }
}

class SequentialIds implements IdGeneratorPort {
  private branch = 0;

  public next(kind: "branch" | "event" | "evaluation" | "evidence"): string {
    if (kind !== "branch") return `${kind}-unused`;
    this.branch += 1;
    return `branch-${this.branch}`;
  }
}

const clock: ClockPort = { nowIso: () => "2026-08-04T00:00:00.000Z" };

const setup = async (): Promise<{
  repository: MemoryRepository;
  factory: FakeEnvironmentFactory;
  runner: BranchRunner;
  checkpointId: CheckpointId;
}> => {
  const repository = new MemoryRepository();
  const factory = new FakeEnvironmentFactory();
  const checkpoint = await repository.putCheckpoint({
    schemaVersion: 1,
    environment: environmentRef,
    nextTick: 0,
    simTimeUs: 0,
    snapshot: initialSnapshot(),
  });
  await repository.putInputTrace({
    schemaVersion: 1,
    inputTraceId: traceId,
    scheduleBasis: "relative_tick",
    inputs: [
      {
        relativeTick: 0,
        order: 0,
        action: "interact",
        target: "/switch",
        payload: {},
      },
    ],
  });
  await repository.putManifest(
    {
      schemaVersion: 1,
      revision: 0,
      runId,
      createdAt: clock.nowIso(),
      source: { commit: "abc", dirty: false, worktreePatchHash: null },
      model: { piSessionId: null, provider: null, model: null },
      environmentAdapter: environmentRef.adapter,
      initialCheckpointId: checkpoint.checkpointId,
      initialInputTraceId: traceId,
      seed: "test",
      branches: [],
    },
    null,
  );
  return {
    repository,
    factory,
    runner: new BranchRunner(
      repository,
      factory,
      [invariant],
      new SequentialIds(),
      clock,
    ),
    checkpointId: checkpoint.checkpointId,
  };
};

const signalEvent = (
  branchId = asBranchId("branch-direct"),
): TelemetryEvent => ({
  schemaVersion: 1,
  eventId: asEventId("signal"),
  runId,
  branchId,
  seq: 0,
  tick: 0,
  simTimeUs: 0,
  kind: "signal",
  source: "/switch",
  name: "activated",
  arguments: [],
});

const framesThrough = (lastTick: number, doorOpensAt?: number) =>
  Array.from({ length: lastTick + 1 }, (_, tick) => ({
    tick,
    simTimeUs: tick * 16_667,
    deltaUs: 16_667,
    state: {
      values: {
        "/switch/active": true,
        "/door/open": doorOpensAt !== undefined && tick >= doorOpensAt,
      },
    },
    eventIds: [],
  }));

describe("EvidenceCompiler deadline semantics", () => {
  it("keeps an open window incomplete, then fails only at inclusive tick 2", () => {
    const compiler = new EvidenceCompiler([invariant]);
    const common = {
      runId,
      branchId: asBranchId("branch-direct"),
      checkpointId: asCheckpointId("checkpoint-direct"),
      baselineState: initialSnapshot().state,
      events: [signalEvent()],
    };

    const early = compiler.compile({ ...common, frames: framesThrough(1) });
    expect(early.evaluations[0]?.status).toBe("incomplete");
    expect(early.evidence).toHaveLength(0);

    const deadline = compiler.compile({ ...common, frames: framesThrough(2) });
    expect(deadline.evaluations[0]).toMatchObject({
      status: "fail",
      deadlineTick: 2,
    });
    expect(deadline.evidence[0]?.observedWindow.closed).toBe(true);
    expect(deadline.evidence[0]?.stateDiff).toContainEqual(
      expect.objectContaining({ path: "/door/open", status: "unchanged" }),
    );
  });

  it("accepts a property becoming true exactly on the inclusive deadline", () => {
    const compiler = new EvidenceCompiler([invariant]);
    const result = compiler.compile({
      runId,
      branchId: asBranchId("branch-direct"),
      checkpointId: asCheckpointId("checkpoint-direct"),
      baselineState: initialSnapshot().state,
      frames: framesThrough(2, 2),
      events: [signalEvent()],
    });

    expect(result.evaluations[0]).toMatchObject({
      status: "pass",
      satisfiedTick: 2,
    });
    expect(result.evidence).toHaveLength(0);
  });
});

describe("BranchRunner", () => {
  it("isolates forks, replays strictly, compares one control, and updates lineage", async () => {
    const { repository, factory, runner, checkpointId } = await setup();
    const root = await runner.createRoot({
      runId,
      checkpointId,
      inputTraceId: traceId,
      controls: { deltaUs: 16_667, maxTicks: 2, variables: {} },
    });
    const baseline = await runner.run(root.branchId);

    expect(baseline.evaluations).toHaveLength(1);
    expect(baseline.evaluations[0]?.status).toBe("fail");
    const bundle = await repository.getEvidence(
      baseline.evidenceIds[0] ?? asEvidenceId("missing"),
    );
    expect(bundle.eventChain.map((event) => event.kind)).toEqual([
      "input",
      "property_changed",
      "signal",
      "log",
    ]);
    expect(bundle.stateDiff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/switch/active", status: "changed" }),
        expect.objectContaining({ path: "/door/open", status: "unchanged" }),
      ]),
    );

    const experiment = await runner.createFork({
      parentBranchId: root.branchId,
      controls: { deltaUs: 16_000 },
    });
    const candidate = await runner.run(experiment.branchId);
    expect(candidate.evaluations[0]?.status).toBe("pass");

    const comparison = await runner.compare(root.branchId, experiment.branchId);
    expect(comparison).toMatchObject({
      baselineOutcome: "fail",
      candidateOutcome: "pass",
      digestsEqual: false,
      firstDivergenceTick: 1,
      changedControls: [{ name: "deltaUs", before: 16_667, after: 16_000 }],
    });

    const strict = await runner.replayStrict(root.branchId);
    expect(strict.matches).toBe(true);
    expect(factory.instances).toHaveLength(3);
    expect(new Set(factory.instances).size).toBe(3);
    expect(repository.checkpoints.get(checkpointId)?.content.snapshot).toEqual(
      initialSnapshot(),
    );

    const manifest = await repository.getManifest(runId);
    expect(manifest.branches).toHaveLength(3);
    expect(
      manifest.branches.find((entry) => entry.branchId === experiment.branchId)
        ?.parentBranchId,
    ).toBe(root.branchId);
    expect(
      manifest.branches.find(
        (entry) => entry.branchId === strict.replayBranchId,
      )?.parentBranchId,
    ).toBe(root.branchId);
    expect(
      manifest.branches.every((entry) => entry.status === "completed"),
    ).toBe(true);
  });
});
