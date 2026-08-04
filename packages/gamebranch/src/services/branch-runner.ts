import {
  asBranchId,
  asEventId,
  type BranchComparison,
  type BranchControls,
  type BranchId,
  type BranchRecord,
  type BranchRun,
  type CheckpointId,
  type EnvironmentEventDraft,
  type EventId,
  type FrameRecord,
  type InputTelemetryEvent,
  type InputTraceId,
  type InvariantResultRef,
  type JsonValue,
  type LogTelemetryEvent,
  type PropertyChangedTelemetryEvent,
  type ReplayMode,
  type RunId,
  type RunManifest,
  type SignalTelemetryEvent,
  type TelemetryEvent,
  type TemporalInvariant,
} from "@chronorift/domain";

import type { ArtifactRepositoryPort } from "../ports/artifact-repository.js";
import type {
  GameEnvironmentFactoryPort,
  RuntimeInput,
} from "../ports/game-environment.js";
import type { ClockPort, IdGeneratorPort } from "../ports/support.js";
import {
  canonicalStringify,
  computeTimelineDigest,
  firstObservationalDivergenceTick,
} from "./canonical.js";
import { EvidenceCompiler } from "./evidence-compiler.js";

export interface CreateRootBranchRequest {
  readonly runId: RunId;
  readonly checkpointId: CheckpointId;
  readonly inputTraceId: InputTraceId;
  readonly controls: BranchControls;
}

export interface BranchControlOverrides {
  readonly deltaUs?: number | undefined;
  readonly maxTicks?: number | undefined;
  readonly variables?: Readonly<Record<string, JsonValue>> | undefined;
}

export interface CreateForkRequest {
  readonly parentBranchId: BranchId;
  readonly checkpointId?: CheckpointId | undefined;
  readonly inputTraceId?: InputTraceId | undefined;
  readonly controls?: BranchControlOverrides | undefined;
  readonly replayMode?: ReplayMode | undefined;
  readonly replayOfBranchId?: BranchId | undefined;
}

export interface StrictReplayResult {
  readonly sourceBranchId: BranchId;
  readonly replayBranchId: BranchId;
  readonly sourceDigest: string;
  readonly replayDigest: string;
  readonly matches: boolean;
}

export class GameBranchError extends Error {
  public override readonly name = "GameBranchError";
}

const inputLocalId = (tick: number, order: number): string =>
  `input:${tick}:${order}`;

const optionalCausation = (
  localId: string | undefined,
  eventIdsByLocalId: ReadonlyMap<string, EventId>,
): { readonly causedByEventId?: EventId } => {
  if (localId === undefined) return {};
  const causedByEventId = eventIdsByLocalId.get(localId);
  if (causedByEventId === undefined) {
    throw new GameBranchError(`Unresolved causation local id: ${localId}`);
  }
  return { causedByEventId };
};

const draftToEvent = (
  draft: EnvironmentEventDraft,
  common: {
    readonly eventId: EventId;
    readonly runId: RunId;
    readonly branchId: BranchId;
    readonly seq: number;
    readonly tick: number;
    readonly simTimeUs: number;
  },
  eventIdsByLocalId: ReadonlyMap<string, EventId>,
): TelemetryEvent => {
  const base = {
    schemaVersion: 1 as const,
    ...common,
    ...optionalCausation(draft.causedByLocalId, eventIdsByLocalId),
  };
  switch (draft.kind) {
    case "signal": {
      const event: SignalTelemetryEvent = {
        ...base,
        kind: draft.kind,
        source: draft.source,
        name: draft.name,
        arguments: draft.arguments,
      };
      return event;
    }
    case "property_changed": {
      const event: PropertyChangedTelemetryEvent = {
        ...base,
        kind: draft.kind,
        path: draft.path,
        before: draft.before,
        after: draft.after,
      };
      return event;
    }
    case "log": {
      const event: LogTelemetryEvent = {
        ...base,
        kind: draft.kind,
        level: draft.level,
        source: draft.source,
        message: draft.message,
        fields: draft.fields,
      };
      return event;
    }
  }
};

const mergeControls = (
  controls: BranchControls,
  overrides: BranchControlOverrides | undefined,
): BranchControls => ({
  deltaUs: overrides?.deltaUs ?? controls.deltaUs,
  maxTicks: overrides?.maxTicks ?? controls.maxTicks,
  variables: {
    ...controls.variables,
    ...(overrides?.variables ?? {}),
  },
});

const aggregateOutcome = (
  evaluations: readonly InvariantResultRef[],
): "pass" | "fail" | "incomplete" | "mixed" => {
  if (evaluations.length === 0) return "incomplete";
  const statuses = new Set(evaluations.map((evaluation) => evaluation.status));
  return statuses.size === 1
    ? (evaluations[0]?.status ?? "incomplete")
    : "mixed";
};

const changedControls = (
  baseline: BranchControls,
  candidate: BranchControls,
): BranchComparison["changedControls"] => {
  const changes: { name: string; before: JsonValue; after: JsonValue }[] = [];
  if (baseline.deltaUs !== candidate.deltaUs) {
    changes.push({
      name: "deltaUs",
      before: baseline.deltaUs,
      after: candidate.deltaUs,
    });
  }
  if (baseline.maxTicks !== candidate.maxTicks) {
    changes.push({
      name: "maxTicks",
      before: baseline.maxTicks,
      after: candidate.maxTicks,
    });
  }
  const variableNames = new Set([
    ...Object.keys(baseline.variables),
    ...Object.keys(candidate.variables),
  ]);
  for (const name of [...variableNames].sort()) {
    const before = baseline.variables[name] ?? null;
    const after = candidate.variables[name] ?? null;
    if (canonicalStringify(before) !== canonicalStringify(after)) {
      changes.push({ name: `variables.${name}`, before, after });
    }
  }
  return changes;
};

export class BranchRunner {
  private readonly evidenceCompiler: EvidenceCompiler;

  public constructor(
    private readonly repository: ArtifactRepositoryPort,
    private readonly environments: GameEnvironmentFactoryPort,
    invariants: readonly TemporalInvariant[],
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
  ) {
    this.evidenceCompiler = new EvidenceCompiler(invariants);
  }

  public async createRoot(
    request: CreateRootBranchRequest,
  ): Promise<BranchRecord> {
    await this.repository.getCheckpoint(request.checkpointId);
    await this.repository.getInputTrace(request.inputTraceId);
    const branch: BranchRecord = {
      schemaVersion: 1,
      branchId: asBranchId(this.ids.next("branch")),
      runId: request.runId,
      forkCheckpointId: request.checkpointId,
      inputTraceId: request.inputTraceId,
      controls: request.controls,
      replayMode: "none",
      status: "created",
      createdAt: this.clock.nowIso(),
    };
    await this.repository.putBranch(branch);
    await this.addBranchToManifest(branch);
    return branch;
  }

  public async createFork(request: CreateForkRequest): Promise<BranchRecord> {
    const parent = await this.repository.getBranch(request.parentBranchId);
    const checkpointId = request.checkpointId ?? parent.forkCheckpointId;
    const inputTraceId = request.inputTraceId ?? parent.inputTraceId;
    await this.repository.getCheckpoint(checkpointId);
    await this.repository.getInputTrace(inputTraceId);
    const branch: BranchRecord = {
      schemaVersion: 1,
      branchId: asBranchId(this.ids.next("branch")),
      runId: parent.runId,
      parentBranchId: parent.branchId,
      forkCheckpointId: checkpointId,
      inputTraceId,
      controls: mergeControls(parent.controls, request.controls),
      replayMode: request.replayMode ?? "experiment",
      ...(request.replayOfBranchId === undefined
        ? {}
        : { replayOfBranchId: request.replayOfBranchId }),
      status: "created",
      createdAt: this.clock.nowIso(),
    };
    await this.repository.putBranch(branch);
    await this.addBranchToManifest(branch);
    return branch;
  }

  public async run(branchId: BranchId): Promise<BranchRun> {
    const original = await this.repository.getBranch(branchId);
    if (original.status !== "created") {
      throw new GameBranchError(
        `Branch ${branchId} cannot run from status ${original.status}`,
      );
    }
    const checkpoint = await this.repository.getCheckpoint(
      original.forkCheckpointId,
    );
    const trace = await this.repository.getInputTrace(original.inputTraceId);
    const running: BranchRecord = { ...original, status: "running" };
    await this.repository.putBranch(running);
    await this.updateManifestBranch(running);

    const environment = await this.environments.create(
      checkpoint.content.environment,
    );
    const frames: FrameRecord[] = [];
    const events: TelemetryEvent[] = [];
    let seq = 0;

    try {
      await environment.restore(checkpoint.content.snapshot);
      for (
        let relativeTick = 0;
        relativeTick <= original.controls.maxTicks;
        relativeTick += 1
      ) {
        const tick = checkpoint.content.nextTick + relativeTick;
        const simTimeUs =
          checkpoint.content.simTimeUs +
          relativeTick * original.controls.deltaUs;
        const scheduled = trace.inputs
          .filter((input) => input.relativeTick === relativeTick)
          .sort((left, right) => left.order - right.order);
        const eventIdsByLocalId = new Map<string, EventId>();
        const frameEvents: TelemetryEvent[] = [];
        const runtimeInputs: RuntimeInput[] = [];

        for (const input of scheduled) {
          const localId = inputLocalId(tick, input.order);
          if (eventIdsByLocalId.has(localId)) {
            throw new GameBranchError(`Duplicate input order at tick ${tick}`);
          }
          const eventId = asEventId(`${branchId}:${seq}`);
          eventIdsByLocalId.set(localId, eventId);
          const inputEvent: InputTelemetryEvent = {
            schemaVersion: 1,
            eventId,
            runId: original.runId,
            branchId,
            seq,
            tick,
            simTimeUs,
            kind: "input",
            action: input.action,
            ...(input.target === undefined ? {} : { target: input.target }),
            payload: input.payload,
          };
          frameEvents.push(inputEvent);
          runtimeInputs.push({
            localId,
            order: input.order,
            action: input.action,
            ...(input.target === undefined ? {} : { target: input.target }),
            payload: input.payload,
          });
          seq += 1;
        }

        const observation = await environment.step({
          tick,
          simTimeUs,
          deltaUs: original.controls.deltaUs,
          inputs: runtimeInputs,
        });
        for (const draft of observation.events) {
          if (eventIdsByLocalId.has(draft.localId)) {
            throw new GameBranchError(
              `Duplicate environment local id: ${draft.localId}`,
            );
          }
          const eventId = asEventId(`${branchId}:${seq}`);
          const event = draftToEvent(
            draft,
            {
              eventId,
              runId: original.runId,
              branchId,
              seq,
              tick,
              simTimeUs,
            },
            eventIdsByLocalId,
          );
          eventIdsByLocalId.set(draft.localId, eventId);
          frameEvents.push(event);
          seq += 1;
        }
        events.push(...frameEvents);
        await this.repository.appendTelemetry(branchId, frameEvents);
        frames.push({
          tick,
          simTimeUs,
          deltaUs: original.controls.deltaUs,
          state: observation.state,
          eventIds: frameEvents.map((event) => event.eventId),
        });
      }

      const compiled = this.evidenceCompiler.compile({
        runId: original.runId,
        branchId,
        checkpointId: checkpoint.checkpointId,
        baselineState: checkpoint.content.snapshot.state,
        frames,
        events,
      });
      for (const evaluation of compiled.evaluations) {
        await this.repository.putEvaluation(evaluation);
      }
      for (const bundle of compiled.evidence) {
        await this.repository.putEvidence(bundle);
      }

      const finalSnapshot = await environment.snapshot();
      const executedFrames = original.controls.maxTicks + 1;
      const finalCheckpoint = await this.repository.putCheckpoint({
        schemaVersion: 1,
        environment: checkpoint.content.environment,
        nextTick: checkpoint.content.nextTick + executedFrames,
        simTimeUs:
          checkpoint.content.simTimeUs +
          executedFrames * original.controls.deltaUs,
        snapshot: finalSnapshot,
      });
      const evaluationRefs: InvariantResultRef[] = compiled.evaluations.map(
        (evaluation) => ({
          evaluationId: evaluation.evaluationId,
          invariantId: evaluation.invariantId,
          status: evaluation.status,
          ...(evaluation.evidenceId === undefined
            ? {}
            : { evidenceId: evaluation.evidenceId }),
        }),
      );
      const run: BranchRun = {
        schemaVersion: 1,
        branchId,
        frames,
        events,
        evaluations: evaluationRefs,
        evidenceIds: compiled.evidence.map((bundle) => bundle.evidenceId),
        timelineDigest: computeTimelineDigest(frames, events),
        finalCheckpointId: finalCheckpoint.checkpointId,
      };
      await this.repository.putBranchRun(run);
      const completed: BranchRecord = { ...running, status: "completed" };
      await this.repository.putBranch(completed);
      await this.updateManifestBranch(completed, run);
      return run;
    } catch (error) {
      const failed: BranchRecord = { ...running, status: "failed" };
      await this.repository.putBranch(failed);
      await this.updateManifestBranch(failed);
      throw error;
    } finally {
      await environment.dispose();
    }
  }

  public async replayStrict(
    sourceBranchId: BranchId,
  ): Promise<StrictReplayResult> {
    const source = await this.repository.getBranch(sourceBranchId);
    const sourceRun = await this.repository.getBranchRun(sourceBranchId);
    if (source.status !== "completed") {
      throw new GameBranchError(
        `Cannot replay incomplete branch ${sourceBranchId}`,
      );
    }
    const replay = await this.createFork({
      parentBranchId: sourceBranchId,
      checkpointId: source.forkCheckpointId,
      inputTraceId: source.inputTraceId,
      controls: {
        deltaUs: source.controls.deltaUs,
        maxTicks: source.controls.maxTicks,
        variables: source.controls.variables,
      },
      replayMode: "strict",
      replayOfBranchId: sourceBranchId,
    });
    const replayRun = await this.run(replay.branchId);
    return {
      sourceBranchId,
      replayBranchId: replay.branchId,
      sourceDigest: sourceRun.timelineDigest,
      replayDigest: replayRun.timelineDigest,
      matches: sourceRun.timelineDigest === replayRun.timelineDigest,
    };
  }

  public async compare(
    baselineBranchId: BranchId,
    candidateBranchId: BranchId,
  ): Promise<BranchComparison> {
    const baselineBranch = await this.repository.getBranch(baselineBranchId);
    const candidateBranch = await this.repository.getBranch(candidateBranchId);
    if (baselineBranch.runId !== candidateBranch.runId) {
      throw new GameBranchError("Cannot compare branches from different runs");
    }
    const baseline = await this.repository.getBranchRun(baselineBranchId);
    const candidate = await this.repository.getBranchRun(candidateBranchId);
    return {
      schemaVersion: 1,
      baselineBranchId,
      candidateBranchId,
      changedControls: changedControls(
        baselineBranch.controls,
        candidateBranch.controls,
      ),
      baselineOutcome: aggregateOutcome(baseline.evaluations),
      candidateOutcome: aggregateOutcome(candidate.evaluations),
      digestsEqual: baseline.timelineDigest === candidate.timelineDigest,
      firstDivergenceTick: firstObservationalDivergenceTick(
        baseline,
        candidate,
      ),
    };
  }

  private async addBranchToManifest(branch: BranchRecord): Promise<void> {
    const manifest = await this.repository.getManifest(branch.runId);
    if (manifest.branches.some((entry) => entry.branchId === branch.branchId)) {
      throw new GameBranchError(`Duplicate manifest branch ${branch.branchId}`);
    }
    const entry = {
      branchId: branch.branchId,
      ...(branch.parentBranchId === undefined
        ? {}
        : { parentBranchId: branch.parentBranchId }),
      forkCheckpointId: branch.forkCheckpointId,
      inputTraceId: branch.inputTraceId,
      controls: branch.controls,
      status: branch.status,
    };
    const updated: RunManifest = {
      ...manifest,
      revision: manifest.revision + 1,
      branches: [...manifest.branches, entry],
    };
    await this.repository.putManifest(updated, manifest.revision);
  }

  private async updateManifestBranch(
    branch: BranchRecord,
    run?: BranchRun,
  ): Promise<void> {
    const manifest = await this.repository.getManifest(branch.runId);
    const found = manifest.branches.some(
      (entry) => entry.branchId === branch.branchId,
    );
    if (!found) {
      throw new GameBranchError(
        `Manifest is missing branch ${branch.branchId}`,
      );
    }
    const branches = manifest.branches.map((entry) =>
      entry.branchId !== branch.branchId
        ? entry
        : {
            ...entry,
            status: branch.status,
            ...(run === undefined
              ? {}
              : {
                  timelineDigest: run.timelineDigest,
                  finalCheckpointId: run.finalCheckpointId,
                }),
          },
    );
    await this.repository.putManifest(
      { ...manifest, revision: manifest.revision + 1, branches },
      manifest.revision,
    );
  }
}
