import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  asRunId,
  type BaselineBranchSpec,
  type EvidenceCapsule,
  type ExecutionLog,
  type FrozenContract,
  type RunId,
} from "@chronorift/domain";
import {
  V01GameBranchService,
  type ClockPort,
  type V01IdGeneratorPort,
} from "@chronorift/gamebranch";
import { V01JsonArtifactRepository } from "@chronorift/json-artifacts";
import {
  MockGameEnvironmentFactory,
  buildV01SwitchDoorFixture,
  type V01SwitchDoorFixture,
} from "@chronorift/mock-game";

class RuntimeV01Ids implements V01IdGeneratorPort {
  next(
    kind: "branch" | "execution" | "comparison" | "capsule" | "verdict",
  ): string {
    return `${kind}:${randomUUID()}`;
  }
}

const systemClock: ClockPort = {
  nowIso: () => new Date().toISOString(),
};

export interface V01MockRunContext {
  readonly runId: RunId;
  readonly artifactRoot: string;
  readonly runDirectory: string;
  readonly repository: V01JsonArtifactRepository;
  readonly gameBranch: V01GameBranchService;
  readonly fixture: V01SwitchDoorFixture;
  readonly contract: FrozenContract;
  readonly baselineBranch: BaselineBranchSpec;
  readonly baselineExecution: ExecutionLog;
  readonly evidenceCapsule: EvidenceCapsule;
}

export interface CreateV01MockRunOptions {
  readonly cwd: string;
  readonly artifactRoot?: string;
  readonly runId?: RunId;
  readonly ids?: V01IdGeneratorPort;
  readonly clock?: ClockPort;
}

/** Build only the original failing execution and its immutable Capsule. */
export async function createV01MockRun(
  options: CreateV01MockRunOptions,
): Promise<V01MockRunContext> {
  const artifactRoot = resolve(
    options.cwd,
    options.artifactRoot ?? ".chronorift",
  );
  const repository = new V01JsonArtifactRepository(artifactRoot);
  const gameBranch = new V01GameBranchService(
    repository,
    new MockGameEnvironmentFactory(),
    options.ids ?? new RuntimeV01Ids(),
    options.clock ?? systemClock,
  );
  const fixture = buildV01SwitchDoorFixture();
  const contract = await gameBranch.freezeContract(fixture.contractInput);
  const checkpoint = await repository.putCheckpoint(
    fixture.initialCheckpointContent,
  );
  await repository.putInputTrace(fixture.inputTrace);
  const runId = options.runId ?? asRunId(`run:${randomUUID()}`);
  const baselineBranch = await gameBranch.createBaseline({
    runId,
    contractId: contract.contractId,
    checkpointId: checkpoint.checkpointId,
    inputTraceId: fixture.inputTrace.inputTraceId,
    controls: fixture.controls,
  });
  const baselineExecution = await gameBranch.execute(baselineBranch.branchId);
  const evidenceCapsule = await gameBranch.compileEvidence({
    executionId: baselineExecution.executionId,
  });
  const runDirectory = await repository.resolveRunDirectory(runId);

  return {
    runId,
    artifactRoot,
    runDirectory,
    repository,
    gameBranch,
    fixture,
    contract,
    baselineBranch,
    baselineExecution,
    evidenceCapsule,
  };
}

export function createV01GameBranchService(
  repository: V01JsonArtifactRepository,
  options: {
    readonly ids?: V01IdGeneratorPort;
    readonly clock?: ClockPort;
  } = {},
): V01GameBranchService {
  return new V01GameBranchService(
    repository,
    new MockGameEnvironmentFactory(),
    options.ids ?? new RuntimeV01Ids(),
    options.clock ?? systemClock,
  );
}
