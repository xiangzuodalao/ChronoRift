import {
  asBranchId,
  asCheckpointId,
  asEvidenceId,
  type BranchId,
  type BranchRun,
  type JsonValue as DomainJsonValue,
  type RunId,
} from "@chronorift/domain";
import type {
  BranchControlOverrides,
  BranchRunner,
} from "@chronorift/gamebranch";
import {
  ArtifactNotFoundError,
  type JsonArtifactRepository,
} from "@chronorift/json-artifacts";
import type {
  AgentEvidence,
  AgentGameApi,
  AgentOutcome,
  AgentReplayResult,
  AgentTimelineBranch,
  AgentTimelineComparison,
  ForkTimelineRequest,
  JsonObject,
} from "@chronorift/pi-harness";

function asJsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function outcome(run: BranchRun): AgentOutcome {
  if (run.evaluations.length === 0) return "incomplete";
  const values = new Set(run.evaluations.map((item) => item.status));
  return values.size === 1
    ? (run.evaluations[0]?.status ?? "incomplete")
    : "mixed";
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value as number;
}

function numberValue(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return value;
}

function parseControlOverrides(
  request: ForkTimelineRequest,
): BranchControlOverrides {
  const controls = request.controls as Readonly<Record<string, unknown>>;
  const allowed = new Set(["deltaUs", "frameRate", "maxTicks", "variables"]);
  const unexpected = Object.keys(controls).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new TypeError(`Unsupported controls: ${unexpected.join(", ")}`);
  }
  if (Object.keys(controls).length !== 1) {
    throw new TypeError(
      "An experiment must change exactly one control at a time",
    );
  }

  const explicitDelta = controls["deltaUs"];
  const frameRate = controls["frameRate"];
  if (explicitDelta !== undefined && frameRate !== undefined) {
    throw new TypeError("Specify either deltaUs or frameRate, not both");
  }
  const deltaUs =
    explicitDelta === undefined
      ? frameRate === undefined
        ? undefined
        : Math.round(1_000_000 / numberValue(frameRate, "frameRate"))
      : positiveInteger(explicitDelta, "deltaUs");
  const maxTicks =
    controls["maxTicks"] === undefined
      ? undefined
      : positiveInteger(controls["maxTicks"], "maxTicks");
  const variablesValue = controls["variables"];
  const variables =
    variablesValue === undefined
      ? undefined
      : (asJsonObject(variablesValue) as unknown as Readonly<
          Record<string, DomainJsonValue>
        >);
  return { deltaUs, maxTicks, variables };
}

export class ChronoRiftAgentGameApi implements AgentGameApi {
  private readonly parentByCheckpoint = new Map<string, BranchId>();

  constructor(
    private readonly runId: RunId,
    private readonly baselineBranchId: BranchId,
    private readonly repository: JsonArtifactRepository,
    private readonly runner: BranchRunner,
  ) {}

  private async rememberInitialCheckpoint(): Promise<void> {
    const branch = await this.repository.getBranch(this.baselineBranchId);
    this.parentByCheckpoint.set(branch.forkCheckpointId, branch.branchId);
  }

  async getEvidence(evidenceId: string): Promise<AgentEvidence | null> {
    try {
      const evidence = await this.repository.getEvidence(
        asEvidenceId(evidenceId),
      );
      if (evidence.runId !== this.runId) return null;
      this.parentByCheckpoint.set(evidence.checkpointId, evidence.branchId);
      return {
        schemaVersion: 1,
        evidenceId: evidence.evidenceId,
        summary: evidence.violationSummary,
        checkpointId: evidence.checkpointId,
        branchId: evidence.branchId,
        eventIds: evidence.sourceEventIds,
        details: asJsonObject({
          invariantId: evidence.invariantId,
          expected: evidence.expected,
          actual: evidence.actual,
          observedWindow: evidence.observedWindow,
          stateDiff: evidence.stateDiff,
          eventChain: evidence.eventChain,
        }),
      };
    } catch (error) {
      if (error instanceof ArtifactNotFoundError) return null;
      throw error;
    }
  }

  async forkTimeline(
    request: ForkTimelineRequest,
  ): Promise<AgentTimelineBranch> {
    await this.rememberInitialCheckpoint();
    const parentBranchId = this.parentByCheckpoint.get(request.checkpointId);
    if (parentBranchId === undefined) {
      throw new Error(
        `No parent branch is associated with ${request.checkpointId}`,
      );
    }
    const parent = await this.repository.getBranch(parentBranchId);
    const overrides = parseControlOverrides(request);
    const changesValue =
      (overrides.deltaUs !== undefined &&
        overrides.deltaUs !== parent.controls.deltaUs) ||
      (overrides.maxTicks !== undefined &&
        overrides.maxTicks !== parent.controls.maxTicks) ||
      (overrides.variables !== undefined &&
        JSON.stringify(overrides.variables) !==
          JSON.stringify(parent.controls.variables));
    if (!changesValue) {
      throw new TypeError("The experiment control must differ from its parent");
    }
    const branch = await this.runner.createFork({
      parentBranchId,
      checkpointId: asCheckpointId(request.checkpointId),
      controls: overrides,
      replayMode: "experiment",
    });
    return {
      schemaVersion: 1,
      branchId: branch.branchId,
      checkpointId: branch.forkCheckpointId,
      controls: asJsonObject(branch.controls),
    };
  }

  async replayTimeline(request: {
    readonly branchId: string;
  }): Promise<AgentReplayResult> {
    const branchId = asBranchId(request.branchId);
    const branch = await this.repository.getBranch(branchId);
    if (branch.runId !== this.runId) {
      throw new Error(`Branch ${branchId} is not part of run ${this.runId}`);
    }
    const run =
      branch.status === "created"
        ? await this.runner.run(branchId)
        : await this.repository.getBranchRun(branchId);
    this.parentByCheckpoint.set(run.finalCheckpointId, branchId);
    const branchOutcome = outcome(run);
    return {
      schemaVersion: 1,
      branchId,
      outcome: branchOutcome,
      evidenceIds: run.evidenceIds,
      finalCheckpointId: run.finalCheckpointId,
      summary: `Timeline ${branchId} completed with ${branchOutcome}`,
      details: asJsonObject({
        timelineDigest: run.timelineDigest,
        controls: branch.controls,
        evaluations: run.evaluations,
        finalState: run.frames.at(-1)?.state.values ?? {},
      }),
    };
  }

  async compareTimelines(request: {
    readonly baselineBranchId: string;
    readonly candidateBranchId: string;
  }): Promise<AgentTimelineComparison> {
    const baselineBranchId = asBranchId(request.baselineBranchId);
    const candidateBranchId = asBranchId(request.candidateBranchId);
    const comparison = await this.runner.compare(
      baselineBranchId,
      candidateBranchId,
    );
    const baseline = await this.repository.getBranchRun(baselineBranchId);
    const candidate = await this.repository.getBranchRun(candidateBranchId);
    const evidenceIds = [
      ...new Set([...baseline.evidenceIds, ...candidate.evidenceIds]),
    ];
    return {
      schemaVersion: 1,
      baselineBranchId,
      candidateBranchId,
      baselineOutcome: comparison.baselineOutcome,
      candidateOutcome: comparison.candidateOutcome,
      evidenceIds,
      firstDivergenceTick: comparison.firstDivergenceTick,
      summary: `${baselineBranchId}=${comparison.baselineOutcome}; ${candidateBranchId}=${comparison.candidateOutcome}`,
      details: asJsonObject({
        changedControls: comparison.changedControls,
        digestsEqual: comparison.digestsEqual,
      }),
    };
  }
}
