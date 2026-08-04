import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  asRunId,
  type BranchRecord,
  type BranchRun,
  type EvidenceBundle,
  type ModelRef,
  type RunId,
  type RunManifest,
} from "@chronorift/domain";
import {
  BranchRunner,
  type ClockPort,
  type IdGeneratorPort,
} from "@chronorift/gamebranch";
import {
  JsonArtifactRepository,
  collectGitSourceRef,
} from "@chronorift/json-artifacts";
import {
  MockGameEnvironmentFactory,
  buildMockSwitchDoorScenario,
  type MockSwitchDoorScenario,
} from "@chronorift/mock-game";

class RuntimeIds implements IdGeneratorPort {
  next(kind: "branch" | "event" | "evaluation" | "evidence"): string {
    return `${kind}:${randomUUID()}`;
  }
}

const systemClock: ClockPort = {
  nowIso: () => new Date().toISOString(),
};

export interface MockRunContext {
  readonly runId: RunId;
  readonly artifactRoot: string;
  readonly repository: JsonArtifactRepository;
  readonly runner: BranchRunner;
  readonly scenario: MockSwitchDoorScenario;
  readonly baselineBranch: BranchRecord;
  readonly baselineRun: BranchRun;
  readonly initialEvidence: EvidenceBundle;
}

export interface CreateMockRunOptions {
  readonly cwd: string;
  readonly artifactRoot?: string;
  readonly model?: ModelRef;
}

export function createBranchRunner(
  repository: JsonArtifactRepository,
  scenario: MockSwitchDoorScenario = buildMockSwitchDoorScenario(),
): BranchRunner {
  return new BranchRunner(
    repository,
    new MockGameEnvironmentFactory(),
    [scenario.invariant],
    new RuntimeIds(),
    systemClock,
  );
}

export async function createMockRun(
  options: CreateMockRunOptions,
): Promise<MockRunContext> {
  const artifactRoot = resolve(
    options.cwd,
    options.artifactRoot ?? ".chronorift",
  );
  const repository = new JsonArtifactRepository(artifactRoot);
  const scenario = buildMockSwitchDoorScenario();
  const checkpoint = await repository.putCheckpoint(
    scenario.initialCheckpointContent,
  );
  await repository.putInputTrace(scenario.trace);

  const runId = asRunId(`run:${randomUUID()}`);
  const manifest: RunManifest = {
    schemaVersion: 1,
    revision: 0,
    runId,
    createdAt: systemClock.nowIso(),
    source: await collectGitSourceRef(options.cwd),
    model: options.model ?? {
      piSessionId: null,
      provider: null,
      model: null,
    },
    environmentAdapter: scenario.environment.adapter,
    initialCheckpointId: checkpoint.checkpointId,
    initialInputTraceId: scenario.trace.inputTraceId,
    seed: "mock:xorshift32:439041101",
    branches: [],
  };
  await repository.putManifest(manifest, null);

  const runner = createBranchRunner(repository, scenario);
  const baselineBranch = await runner.createRoot({
    runId,
    checkpointId: checkpoint.checkpointId,
    inputTraceId: scenario.trace.inputTraceId,
    controls: scenario.controls.baseline,
  });
  const baselineRun = await runner.run(baselineBranch.branchId);
  const evidenceId = baselineRun.evidenceIds[0];
  if (evidenceId === undefined) {
    throw new Error("Mock baseline did not produce anomaly evidence");
  }
  const initialEvidence = await repository.getEvidence(evidenceId);

  return {
    runId,
    artifactRoot,
    repository,
    runner,
    scenario,
    baselineBranch,
    baselineRun,
    initialEvidence,
  };
}
