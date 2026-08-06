import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  FrozenContractBundleV3Schema,
  asInvestigationId,
  asRunId,
  type ClaimPolicyManifestV1,
  type EvidenceCapsuleV2,
  type FrozenContractBundleV3,
  type InvestigationId,
  type JsonValue,
  type RunId,
  type Sha256Hex,
  type V03BranchSpec,
  type V03ExecutionLog,
} from "@chronorift/domain";
import {
  V04GameBranchService,
  v04ClaimPolicyManifestFor,
  v04ContentHash,
  v04ContractIdFor,
  type ClockPort,
  type InvestigationSpecV1,
  type V03IdGeneratorPort,
} from "@chronorift/gamebranch";
import {
  GodotGameEnvironmentFactory,
  createGodotClaimEvidencePolicyRegistry,
  prepareV03GodotFixture,
  type PreparedV03GodotFixture,
  type V03FixtureName,
} from "@chronorift/godot-adapter";
import { V04JsonArtifactRepository } from "@chronorift/json-artifacts";

class RuntimeV04Ids implements V03IdGeneratorPort {
  public next(
    kind: "branch" | "execution" | "comparison" | "capsule" | "verdict",
  ): string {
    return `${kind}:v04:${randomUUID()}`;
  }
}

const systemClock: ClockPort = { nowIso: () => new Date().toISOString() };
const sha = (value: string): Sha256Hex => value;

const contractFor = (
  fixtureName: V03FixtureName,
  prepared: PreparedV03GodotFixture,
): FrozenContractBundleV3 => {
  const content: Omit<FrozenContractBundleV3, "contractId"> = {
    schemaVersion: 3,
    contractVersion: "1.0.0",
    scope: {
      projectId: `chronorift.godot.${fixtureName}`,
      scenePath: prepared.environment.scene,
      fixtureId: prepared.fixture.fixtureId,
      entityBindings: {
        triggerSource: prepared.fixture.contractInput.rule.trigger.source,
        expectedProperty: prepared.fixture.contractInput.rule.expectation.path,
      },
    },
    authority: {
      status: "frozen",
      authoredBy: "chronorift-fixture-authors",
      approvedBy: prepared.fixture.contractInput.authority.approvedBy,
      approvedAt: "2026-08-06T00:00:00.000Z",
    },
    evaluator: {
      evaluatorId: "chronorift.temporal.signal-property",
      evaluatorVersion: "1.0.0",
      evaluatorHash: sha(
        v04ContentHash({
          evaluatorId: "chronorift.temporal.signal-property",
          evaluatorVersion: "1.0.0",
          semantics:
            "property equals expected value within inclusive ticks after signal",
        }),
      ),
    },
    rule: prepared.fixture.contractInput.rule,
  };
  return FrozenContractBundleV3Schema.parse({
    ...content,
    contractId: v04ContractIdFor(content),
  });
};

const investigationSpecFor = (
  fixtureName: V03FixtureName,
  prepared: PreparedV03GodotFixture,
  contract: FrozenContractBundleV3,
  claimPolicyManifest: ClaimPolicyManifestV1,
  runId: RunId,
): InvestigationSpecV1 => {
  const investigationId: InvestigationId = asInvestigationId(
    `investigation:v1:${v04ContentHash({
      fixtureName,
      runId,
      projectHash: prepared.projectHash,
      contractId: contract.contractId,
    })}`,
  );
  return {
    schemaVersion: 1,
    investigationId,
    executionSubjectId: prepared.fixture.fixtureId,
    contract,
    claimPolicyManifest,
    initialCheckpointContent: prepared.fixture.initialCheckpointContent,
    inputTrace: prepared.fixture.inputTrace,
    baselineControls: prepared.fixture.baselineControls,
    probeProperties: prepared.fixture.probeProperties,
    interventions: prepared.fixture.experiments,
    experimentBudget: {
      maxInterventions: Math.min(2, prepared.fixture.experiments.length),
    },
    runtimeControlDefaults: prepared.fixture.fixtureControlDefaults,
    checkpointLimitations: prepared.fixture.checkpointLimitations,
    fingerprint: {
      repositoryId: "chronorift",
      sourceTreeHash: sha(prepared.projectHash),
      gitRevision: null,
      dirtyPatchHash: null,
      gameBuildHash: sha(prepared.projectHash),
      importCacheHash: null,
      physicsEngine: "godot_builtin",
      pluginVersion: `chronoprobe:${prepared.addonHash}`,
      inputMapHash: sha(
        v04ContentHash({
          actions: prepared.fixture.inputTrace.inputs.map(
            (input) => input.action,
          ),
        }),
      ),
      probeProfileHash: sha(
        v04ContentHash({
          signals: [prepared.fixture.contractInput.rule.trigger],
          properties: prepared.fixture.probeProperties,
        } as unknown as JsonValue),
      ),
      telemetrySchemaHash: sha(
        v04ContentHash({
          schema: "V03TelemetryEvent",
          schemaVersion: 2,
        }),
      ),
    },
  };
};

export interface V04RunContext {
  readonly runId: RunId;
  readonly investigationId: InvestigationId;
  readonly artifactRoot: string;
  readonly runDirectory: string;
  readonly preparedFixture: PreparedV03GodotFixture;
  readonly investigation: InvestigationSpecV1;
  readonly repository: V04JsonArtifactRepository;
  readonly gameBranch: V04GameBranchService;
  readonly contract: FrozenContractBundleV3;
  readonly baselineBranch: V03BranchSpec;
  readonly baselineExecution: V03ExecutionLog;
  readonly evidenceCapsule: EvidenceCapsuleV2;
}

export interface CreateV04RunOptions {
  readonly cwd: string;
  readonly fixture: V03FixtureName;
  readonly artifactRoot?: string | undefined;
  readonly runId?: RunId | undefined;
  readonly godotBin?: string | undefined;
  readonly ids?: V03IdGeneratorPort | undefined;
  readonly clock?: ClockPort | undefined;
}

export async function createV04Run(
  options: CreateV04RunOptions,
): Promise<V04RunContext> {
  const artifactRoot = resolve(
    options.cwd,
    options.artifactRoot ?? ".chronorift",
  );
  const preparedFixture = await prepareV03GodotFixture(options.fixture, {
    cwd: options.cwd,
    artifactRoot,
    ...(options.godotBin === undefined ? {} : { godotBin: options.godotBin }),
  });
  const runId = options.runId ?? asRunId(`run:v04:${randomUUID()}`);
  const contract = contractFor(options.fixture, preparedFixture);
  const policies = createGodotClaimEvidencePolicyRegistry();
  const investigation = investigationSpecFor(
    options.fixture,
    preparedFixture,
    contract,
    v04ClaimPolicyManifestFor(policies.descriptors()),
    runId,
  );
  const repository = new V04JsonArtifactRepository(artifactRoot, runId);
  const gameBranch = new V04GameBranchService(
    repository,
    new GodotGameEnvironmentFactory({
      binary: preparedFixture.doctor.binary,
      projectDirectory: preparedFixture.projectDirectory,
      runtimeRoot: resolve(artifactRoot, "godot-runtime-v04"),
    }),
    investigation,
    policies,
    options.ids ?? new RuntimeV04Ids(),
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
    investigationId: investigation.investigationId,
    artifactRoot,
    runDirectory: repository.runDirectory,
    preparedFixture,
    investigation,
    repository,
    gameBranch,
    contract,
    baselineBranch: initialized.branch,
    baselineExecution,
    evidenceCapsule,
  };
}
