import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  asRunId,
  type EvidenceCapsuleV2,
  type FrozenContractV2,
  type RunId,
  type V03BranchSpec,
  type V03ExecutionLog,
} from "@chronorift/domain";
import {
  V03GameBranchService,
  type ClockPort,
  type V03IdGeneratorPort,
} from "@chronorift/gamebranch";
import {
  GodotGameEnvironmentFactory,
  prepareV03GodotFixture,
  type PreparedV03GodotFixture,
  type V03FixtureName,
} from "@chronorift/godot-adapter";
import { V03JsonArtifactRepository } from "@chronorift/json-artifacts";

class RuntimeV03Ids implements V03IdGeneratorPort {
  public next(
    kind: "branch" | "execution" | "comparison" | "capsule" | "verdict",
  ): string {
    return `${kind}:v03:${randomUUID()}`;
  }
}

const systemClock: ClockPort = { nowIso: () => new Date().toISOString() };

export interface V03RunContext {
  readonly runId: RunId;
  readonly artifactRoot: string;
  readonly runDirectory: string;
  readonly preparedFixture: PreparedV03GodotFixture;
  readonly repository: V03JsonArtifactRepository;
  readonly gameBranch: V03GameBranchService;
  readonly contract: FrozenContractV2;
  readonly baselineBranch: V03BranchSpec;
  readonly baselineExecution: V03ExecutionLog;
  readonly evidenceCapsule: EvidenceCapsuleV2;
}

export interface CreateV03RunOptions {
  readonly cwd: string;
  readonly fixture: V03FixtureName;
  readonly artifactRoot?: string | undefined;
  readonly runId?: RunId | undefined;
  readonly godotBin?: string | undefined;
  readonly ids?: V03IdGeneratorPort | undefined;
  readonly clock?: ClockPort | undefined;
}

export async function createV03Run(
  options: CreateV03RunOptions,
): Promise<V03RunContext> {
  const artifactRoot = resolve(
    options.cwd,
    options.artifactRoot ?? ".chronorift",
  );
  const preparedFixture = await prepareV03GodotFixture(options.fixture, {
    cwd: options.cwd,
    artifactRoot,
    ...(options.godotBin === undefined ? {} : { godotBin: options.godotBin }),
  });
  const runId = options.runId ?? asRunId(`run:v03:${randomUUID()}`);
  const repository = new V03JsonArtifactRepository(artifactRoot, runId);
  const gameBranch = new V03GameBranchService(
    repository,
    new GodotGameEnvironmentFactory({
      binary: preparedFixture.doctor.binary,
      projectDirectory: preparedFixture.projectDirectory,
      runtimeRoot: resolve(artifactRoot, "godot-runtime"),
    }),
    preparedFixture.fixture,
    options.ids ?? new RuntimeV03Ids(),
    options.clock ?? systemClock,
  );
  const initialized = await gameBranch.initialize(runId);
  const baselineExecution = await gameBranch.execute(
    initialized.branch.branchId,
  );
  const evidenceCapsule = await gameBranch.compileEvidence(
    baselineExecution.executionId,
  );
  return {
    runId,
    artifactRoot,
    runDirectory: repository.runDirectory,
    preparedFixture,
    repository,
    gameBranch,
    contract: initialized.contract,
    baselineBranch: initialized.branch,
    baselineExecution,
    evidenceCapsule,
  };
}
