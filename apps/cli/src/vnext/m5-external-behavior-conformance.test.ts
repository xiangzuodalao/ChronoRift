import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SEMANTIC_GAME_TOOL_NAMES_V1 } from "@chronorift/agent-protocol";
import {
  TaskPatchIdentityV1Schema,
  VNextBuildV1Schema,
  VNextSemanticExecutionRecordV1Schema,
  VNextSemanticExecutionSealV1Schema,
  VNextSemanticObservationEventV1Schema,
  VNextSemanticRuntimeRecordV1Schema,
  asTaskId,
  taskNamespaceDigestV1,
  type JsonValue,
  type VNextSemanticObservationEventV1,
} from "@chronorift/domain";
import {
  VNextTaskStore,
  canonicalJson,
  contentHash,
} from "@chronorift/json-artifacts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  M5_CLAIMS_EXCLUDED_V1,
  M5_EVIDENCE_SCHEMA_RAW_SHA256_V1,
  M5_TASK_PROMPT_V1,
  M5_TASK_SPEC_RAW_SHA256_V1,
  M5TaskSpecV1Schema,
  createM5CleanupReceiptV1,
  createM5EvidenceManifestV1,
  createM5EvidenceSummaryV1,
  createM5OwnedTemporaryDirectoryV1,
  createM5StagingRootV1,
  finalizeM5OwnershipV1,
  publishM5StagingRootV1,
  readM5SandboxRealizationV1,
  readM5TaskSpecV1,
  removeM5OwnedTemporaryDirectoryV1,
  removeM5StagingRootV1,
  requireM5PostDiscardIsolationV1,
  requireM5PatchExportV1,
  requireM5TrackedGdPathsV1,
  selectM5ExecutionEvidenceV1,
  sha256Bytes,
  writeM5CanonicalArtifactV1,
  type M5ExecutionEvidenceInputV1,
  type M5TaskSpecV1,
} from "./m5-external-behavior-conformance.js";
import {
  SandboxOperationRecordV1Schema,
  SandboxPolicySchema,
} from "./contracts.js";
import { resolveResourceLimitsV1 } from "./sandbox-policy.js";

const HASH = "a".repeat(64);
const BASELINE_HASH =
  "3e8bd6478d53586284010da38959005e2a377ef6277b2a838ecb1538abc096e8";
const CANDIDATE_HASH = "c".repeat(64);
const taskId = asTaskId("task:m5-unit");
const temporaryRoots: string[] = [];
let taskSpec: M5TaskSpecV1;

beforeAll(async () => {
  const taskSpecPath = join(
    process.cwd(),
    "testdata/vnext/m5/moddable-platformer.behavior-change-task.v1.json",
  );
  const schemaPath = join(
    process.cwd(),
    "testdata/vnext/m5/evidence-bundle.schema.v1.json",
  );
  const [loaded, schemaBytes] = await Promise.all([
    readM5TaskSpecV1(taskSpecPath),
    readFile(schemaPath),
  ]);
  taskSpec = loaded.spec;
  expect(loaded.rawSha256).toBe(M5_TASK_SPEC_RAW_SHA256_V1);
  expect(sha256Bytes(schemaBytes)).toBe(M5_EVIDENCE_SCHEMA_RAW_SHA256_V1);
  expect(taskSpec.prompt).toBe(M5_TASK_PROMPT_V1);
  expect(taskSpec.prompt).toContain("Mandatory evidence checkpoint");
  expect(taskSpec.prompt).toContain("not a baseline execution");
  expect(taskSpec.prompt).toContain("cannot be reconstructed after editing");
  expect(taskSpec.prompt).not.toContain("interpreted in seconds");
  expect(taskSpec.prompt).not.toContain("/ 1000");
  expect(taskSpec.claimsExcluded).toEqual(M5_CLAIMS_EXCLUDED_V1);
  expect(taskSpec.claimsExcluded).toContain("root_cause_correctness");
});

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

const projection = (input: {
  readonly simulationTimeUs: number;
  readonly waitTimeSeconds: number;
  readonly spawnOrdinal: number;
}) => ({
  schemaVersion: 1 as const,
  stateSchemaVersion: "chronorift.timer-spawn:v1" as const,
  subject: {
    stableId: "semantic:subject" as const,
    incarnation: 1,
    targetScene: taskSpec.semanticProfile.targetScene,
    spawnIntervalSeconds: 1,
    spawnScene: "res://components/enemy/enemy.tscn",
  },
  timer: {
    stableId: "semantic:timer" as const,
    incarnation: 1,
    waitTimeSeconds: input.waitTimeSeconds,
    timeLeftSeconds: Math.max(0, input.waitTimeSeconds / 2),
    paused: false,
    stopped: false,
    oneShot: false,
    autostart: true,
    processCallback: "idle" as const,
    ignoreTimeScale: false,
    timeoutOrdinal: input.spawnOrdinal,
  },
  entities:
    input.spawnOrdinal === 0
      ? []
      : [
          {
            stableId: "semantic:spawn:0",
            incarnation: 1,
            spawnOrdinal: 0,
            scene: "res://components/enemy/enemy.tscn",
            parentStableId: "semantic:harness" as const,
            transform: {
              position: { x: 0, y: 0 },
              rotation: 0,
              scale: { x: 1, y: 1 },
            },
            visible: true,
            processMode: 0,
            velocity: { x: 0, y: 0 },
          },
        ],
  nextSpawnOrdinal: input.spawnOrdinal,
  capturedAt: {
    processFrame: Math.floor(input.simulationTimeUs / 16_667),
    physicsTick: Math.floor(input.simulationTimeUs / 16_667),
    simulationTimeUs: input.simulationTimeUs,
    hostMonotonicUs: null,
    renderFrame: null,
  },
});

const executionEvidence = (input: {
  readonly role: "baseline" | "candidate" | "intermediate";
  readonly identitySuffix?: string;
  readonly sourceHash: string;
  readonly samples: readonly {
    readonly simulationTimeUs: number;
    readonly waitTimeSeconds: number;
    readonly spawnOrdinal: number;
  }[];
  readonly hostMonotonicBaseUs?: number;
}): M5ExecutionEvidenceInputV1 => {
  const identity = `${input.role}${input.identitySuffix ?? ""}`;
  const executionId = `execution:m5:${identity}`;
  const runtimeId = `runtime:m5:${identity}`;
  const buildId = `build:m5:${identity}`;
  const events = input.samples.map((sample, sequence) => {
    const value = projection(sample);
    return VNextSemanticObservationEventV1Schema.parse({
      schemaVersion: 1,
      eventKind: "semantic_observation",
      taskId,
      executionId,
      runtimeId,
      buildId,
      sequence,
      source:
        sequence === 0
          ? "ready"
          : sequence === input.samples.length - 1
            ? "shutdown"
            : "status",
      hostMonotonicStartUs:
        (input.hostMonotonicBaseUs ??
          (input.role === "baseline" ? 10_000_000 : 20_000_000)) +
        sample.simulationTimeUs,
      hostMonotonicEndUs:
        (input.hostMonotonicBaseUs ??
          (input.role === "baseline" ? 10_000_000 : 20_000_000)) +
        sample.simulationTimeUs +
        100,
      projectionSha256: contentHash(value),
      projection: value,
    });
  });
  const seal = {
    schemaVersion: 1 as const,
    taskId,
    executionId,
    count: events.length,
    headHash: HASH,
    byteLength: 1024,
    contentHash: HASH,
  };
  const finalProjection = events.at(-1)!.projection;
  const build = VNextBuildV1Schema.parse({
    schemaVersion: 1,
    taskId,
    workspaceId: "workspace:m5-unit",
    sourceId: `source:${input.sourceHash}`,
    buildId,
    sourceHash: input.sourceHash,
    workspaceDiffHash: contentHash({
      schemaVersion: 1,
      baselineSourceHash: taskSpec.source.selectedTreeSha256,
      candidateSourceHash: input.sourceHash,
    }),
    buildConfigurationHash: HASH,
    outputHash: HASH,
    createdAt: "2026-08-12T00:00:00.000Z",
  });
  const runtime = VNextSemanticRuntimeRecordV1Schema.parse({
    schemaVersion: 1,
    runtimeKind: "godot_external_semantic",
    taskId,
    runtimeId,
    executionId,
    buildId,
    adapterId: "adapter:m5-unit",
    adapterProfileSha256:
      taskSpec.semanticProfile.adapterProfileCanonicalSha256,
    status: "stopped",
    finalProjectionSha256: contentHash(finalProjection),
    finalProjection,
    coverage: [],
    loss: [],
    cleanupProven: true,
  });
  const execution = VNextSemanticExecutionRecordV1Schema.parse({
    schemaVersion: 1,
    executionKind: "godot_external_semantic",
    taskId,
    executionId,
    runtimeId,
    workspaceId: "workspace:m5-unit",
    sourceId: `source:${input.sourceHash}`,
    buildId,
    adapterId: "adapter:m5-unit",
    adapterProfileSha256:
      taskSpec.semanticProfile.adapterProfileCanonicalSha256,
    targetScene: taskSpec.semanticProfile.targetScene,
    stateSchemaVersion: "chronorift.timer-spawn:v1",
    fidelity: "descriptive_only",
    equivalentForkEligible: false,
    eventCount: events.length,
    coverage: [],
    loss: [],
    executionSeal: seal,
  });
  return {
    build,
    runtime,
    execution,
    events: events as readonly VNextSemanticObservationEventV1[],
    seal: VNextSemanticExecutionSealV1Schema.parse(seal),
  };
};

const baseline = () =>
  executionEvidence({
    role: "baseline",
    sourceHash: BASELINE_HASH,
    samples: [
      { simulationTimeUs: 10_000, waitTimeSeconds: 0.001, spawnOrdinal: 1 },
      { simulationTimeUs: 20_000, waitTimeSeconds: 0.001, spawnOrdinal: 2 },
    ],
  });

const candidate = () =>
  executionEvidence({
    role: "candidate",
    sourceHash: CANDIDATE_HASH,
    samples: [
      { simulationTimeUs: 10_000, waitTimeSeconds: 1, spawnOrdinal: 0 },
      { simulationTimeUs: 200_000, waitTimeSeconds: 1, spawnOrdinal: 0 },
      { simulationTimeUs: 100_010_000, waitTimeSeconds: 1, spawnOrdinal: 1 },
      { simulationTimeUs: 100_100_000, waitTimeSeconds: 1, spawnOrdinal: 1 },
    ],
  });

const patchIdentity = () =>
  TaskPatchIdentityV1Schema.parse({
    schemaVersion: 1,
    patchId: `patch:v1:${HASH}`,
    taskId,
    baselineSourceHash: BASELINE_HASH,
    candidateSourceHash: CANDIDATE_HASH,
    patchHash: HASH,
    byteLength: 1,
  });

const sandboxRealizationHarness = async (input?: {
  readonly receiptPolicyId?: string;
  readonly storageReconciled?: boolean | undefined;
  readonly observeAggregateStorage?: boolean;
}) => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-m5-sandbox-"));
  temporaryRoots.push(root);
  const runtimeRoot = join(root, "runtime");
  await mkdir(join(runtimeRoot, "tasks", taskNamespaceDigestV1(taskId)), {
    recursive: true,
    mode: 0o700,
  });
  const store = new VNextTaskStore(runtimeRoot);
  await store.create(taskId);
  const limits = resolveResourceLimitsV1("coding-default", undefined);
  const policyContent = {
    schemaVersion: 1 as const,
    runtimeIdentity: HASH,
    toolchainId: null,
    writableTargets: ["/workspace", "/tmp", "/artifacts"] as const,
    readonlyTargets: ["/bin/busybox"],
    namespaces: ["mount", "user", "pid", "ipc", "uts", "network"] as const,
    network: "isolated" as const,
    copiedEnvironmentKeys: ["CI", "NO_COLOR"] as const,
    profiles: {
      "coding-default": limits,
      "godot-headless": resolveResourceLimitsV1("godot-headless", undefined),
    },
  };
  const policy = SandboxPolicySchema.parse({
    ...policyContent,
    policyId: `sandbox-policy:v1:${contentHash(
      policyContent as unknown as JsonValue,
    )}`,
  });
  const observeAggregateStorage = input?.observeAggregateStorage ?? true;
  const emptySha256 = sha256Bytes(Buffer.alloc(0));
  const operation = SandboxOperationRecordV1Schema.parse({
    schemaVersion: 1,
    taskId,
    recordedAt: "2026-08-12T00:00:00.000Z",
    receipt: {
      schemaVersion: 1,
      taskId,
      operationId: "m5_sandbox_realization",
      policyId: input?.receiptPolicyId ?? policy.policyId,
      sandboxCapabilitySha256: HASH,
      sandboxBackend: "bwrap-direct-cgroup-v2",
      status: "succeeded",
      requested: {
        schemaVersion: 1,
        operationId: "m5_sandbox_realization",
        profile: "coding-default",
        argv: ["/bin/busybox", "true"],
        cwd: "/workspace",
        environment: {},
      },
      realizedResources: limits,
      realizedMechanisms: {
        cpu: "cgroup-v2",
        memory: "cgroup-v2",
        processCount: "cgroup-v2",
        openFiles: "rlimit-nofile",
        fileSize: "rlimit-fsize",
        wallTimeout: "host-monotonic-timer",
        ...(observeAggregateStorage
          ? {
              aggregateStorage:
                "dedicated-capacity-bounded-filesystem-v1" as const,
              unavailable: [] as const,
            }
          : { unavailable: ["aggregate-storage"] as const }),
      },
      resourceUsage: {
        cpuUsageUsec: 1,
        memoryPeakBytes: 2,
        pidsPeak: 1,
        ...(observeAggregateStorage
          ? { aggregateStorage: { usedBytes: 4_096, usedInodes: 12 } }
          : {}),
      },
      stdout: {
        totalBytes: 0,
        capturedBytes: 0,
        sha256: emptySha256,
        capturedSha256: emptySha256,
        truncated: false,
      },
      stderr: {
        totalBytes: 0,
        capturedBytes: 0,
        sha256: emptySha256,
        capturedSha256: emptySha256,
        truncated: false,
      },
      exitCode: 0,
      signal: null,
      startedAtMonotonicMs: 1,
      endedAtMonotonicMs: 2,
      cleanup: {
        processGroupTerminated: true,
        cgroupPopulated: false,
        termSent: false,
        killSent: false,
        scopeRemoved: true,
        ...(input?.storageReconciled === undefined
          ? {}
          : { storageReconciled: input.storageReconciled }),
      },
      mountAdmission: {
        schemaVersion: 1,
        evidenceBasis: "validated-process-plan",
        profile: "coding-default",
        workspaceAccess: "read-write",
        taskSharedWritableTargets: ["/tmp", "/artifacts"],
        operationPrivateWritableTargets: [],
        readonlyTargetCount: 1,
        readonlyTargetsSha256: HASH,
        mountCount: 4,
        mountPlanSha256: HASH,
        credentialTargetCount: 0,
      },
    },
  });
  await Promise.all([
    store.putJsonOnce(taskId, "sandbox-policy.json", policy, (value) =>
      SandboxPolicySchema.parse(value),
    ),
    store.append(taskId, "sandbox-operations.jsonl", operation, (value) =>
      SandboxOperationRecordV1Schema.parse(value),
    ),
  ]);
  return { runtimeRoot };
};

describe("M5 external behavior conformance", () => {
  it("selects source-bound sealed baseline and final-candidate behavior", () => {
    const selected = selectM5ExecutionEvidenceV1({
      taskId,
      taskSpec,
      patchIdentity: patchIdentity(),
      executions: [candidate(), baseline()],
    });
    expect(selected.baselineObservation).toMatchObject({
      sourceHash: BASELINE_HASH,
      decisiveSpawnOrdinal: 1,
    });
    expect(selected.candidateEarlyObservation).toMatchObject({
      sourceHash: CANDIDATE_HASH,
      decisiveSpawnOrdinal: 0,
    });
    expect(selected.candidateLaterObservation).toMatchObject({
      sourceHash: CANDIDATE_HASH,
      decisiveSpawnOrdinal: 1,
      decisiveRelativeSimulationTimeUs: 100_000_000,
    });
  });

  it("accepts a candidate spawn sampled after a long Host/model delay", () => {
    const delayedCandidate = executionEvidence({
      role: "candidate",
      sourceHash: CANDIDATE_HASH,
      samples: [
        { simulationTimeUs: 10_000, waitTimeSeconds: 1, spawnOrdinal: 0 },
        { simulationTimeUs: 200_000, waitTimeSeconds: 1, spawnOrdinal: 0 },
        {
          simulationTimeUs: 182_010_000,
          waitTimeSeconds: 1,
          spawnOrdinal: 1,
        },
        {
          simulationTimeUs: 182_100_000,
          waitTimeSeconds: 1,
          spawnOrdinal: 1,
        },
      ],
    });

    const selected = selectM5ExecutionEvidenceV1({
      taskId,
      taskSpec,
      patchIdentity: patchIdentity(),
      executions: [baseline(), delayedCandidate],
    });

    expect(selected.candidateLaterObservation).toMatchObject({
      sourceHash: CANDIDATE_HASH,
      decisiveSpawnOrdinal: 1,
      decisiveRelativeSimulationTimeUs: 182_000_000,
    });
  });

  it("still rejects a candidate spawn observed before the minimum later endpoint", () => {
    const prematureCandidate = executionEvidence({
      role: "candidate",
      sourceHash: CANDIDATE_HASH,
      samples: [
        { simulationTimeUs: 10_000, waitTimeSeconds: 1, spawnOrdinal: 0 },
        { simulationTimeUs: 200_000, waitTimeSeconds: 1, spawnOrdinal: 0 },
        { simulationTimeUs: 800_000, waitTimeSeconds: 1, spawnOrdinal: 1 },
        { simulationTimeUs: 850_000, waitTimeSeconds: 1, spawnOrdinal: 1 },
      ],
    });

    expect(() =>
      selectM5ExecutionEvidenceV1({
        taskId,
        taskSpec,
        patchIdentity: patchIdentity(),
        executions: [baseline(), prematureCandidate],
      }),
    ).toThrow(/final-candidate execution/iu);
  });

  it("accepts a candidate spawn at the exact minimum later endpoint", () => {
    const boundaryCandidate = executionEvidence({
      role: "candidate",
      sourceHash: CANDIDATE_HASH,
      samples: [
        { simulationTimeUs: 10_000, waitTimeSeconds: 1, spawnOrdinal: 0 },
        { simulationTimeUs: 200_000, waitTimeSeconds: 1, spawnOrdinal: 0 },
        { simulationTimeUs: 910_000, waitTimeSeconds: 1, spawnOrdinal: 1 },
        { simulationTimeUs: 920_000, waitTimeSeconds: 1, spawnOrdinal: 1 },
      ],
    });

    const selected = selectM5ExecutionEvidenceV1({
      taskId,
      taskSpec,
      patchIdentity: patchIdentity(),
      executions: [baseline(), boundaryCandidate],
    });

    expect(
      selected.candidateLaterObservation.decisiveRelativeSimulationTimeUs,
    ).toBe(900_000);
  });

  it("accepts a baseline spawn sampled after a Host-delayed status call", () => {
    const delayedBaseline = executionEvidence({
      role: "baseline",
      sourceHash: BASELINE_HASH,
      samples: [
        { simulationTimeUs: 10_000, waitTimeSeconds: 0.001, spawnOrdinal: 0 },
        {
          simulationTimeUs: 1_010_000,
          waitTimeSeconds: 0.001,
          spawnOrdinal: 1,
        },
        {
          simulationTimeUs: 1_020_000,
          waitTimeSeconds: 0.001,
          spawnOrdinal: 1,
        },
      ],
    });

    const selected = selectM5ExecutionEvidenceV1({
      taskId,
      taskSpec,
      patchIdentity: patchIdentity(),
      executions: [delayedBaseline, candidate()],
    });

    expect(selected.baselineObservation).toMatchObject({
      sourceHash: BASELINE_HASH,
      decisiveSpawnOrdinal: 1,
      decisiveRelativeSimulationTimeUs: 1_000_000,
    });
  });

  it("still requires a broken Timer throughout and an observed baseline spawn", () => {
    const noSpawn = executionEvidence({
      role: "baseline",
      sourceHash: BASELINE_HASH,
      samples: [
        { simulationTimeUs: 10_000, waitTimeSeconds: 0.001, spawnOrdinal: 0 },
        {
          simulationTimeUs: 1_010_000,
          waitTimeSeconds: 0.001,
          spawnOrdinal: 0,
        },
      ],
    });
    expect(() =>
      selectM5ExecutionEvidenceV1({
        taskId,
        taskSpec,
        patchIdentity: patchIdentity(),
        executions: [noSpawn, candidate()],
      }),
    ).toThrow(/spawned-entity observation/iu);

    const wrongTimer = executionEvidence({
      role: "baseline",
      sourceHash: BASELINE_HASH,
      samples: [
        { simulationTimeUs: 10_000, waitTimeSeconds: 0.001, spawnOrdinal: 0 },
        { simulationTimeUs: 1_010_000, waitTimeSeconds: 1, spawnOrdinal: 1 },
      ],
    });
    expect(() =>
      selectM5ExecutionEvidenceV1({
        taskId,
        taskSpec,
        patchIdentity: patchIdentity(),
        executions: [wrongTimer, candidate()],
      }),
    ).toThrow(/approximately 1 ms Timer/iu);
  });

  it("fails closed on an early candidate spawn or a detached final identity", () => {
    const early = executionEvidence({
      role: "candidate",
      sourceHash: CANDIDATE_HASH,
      samples: [
        { simulationTimeUs: 10_000, waitTimeSeconds: 1, spawnOrdinal: 1 },
        { simulationTimeUs: 1_010_000, waitTimeSeconds: 1, spawnOrdinal: 2 },
      ],
    });
    expect(() =>
      selectM5ExecutionEvidenceV1({
        taskId,
        taskSpec,
        patchIdentity: patchIdentity(),
        executions: [baseline(), early],
      }),
    ).toThrow(/final-candidate execution/iu);
    const detached = candidate();
    expect(() =>
      selectM5ExecutionEvidenceV1({
        taskId,
        taskSpec,
        patchIdentity: patchIdentity(),
        executions: [
          baseline(),
          {
            ...detached,
            runtime: { ...detached.runtime, cleanupProven: false },
          },
        ],
      }),
    ).toThrow(/cleanup-proven/iu);
  });

  it("rejects a candidate execution that begins before the baseline", () => {
    const lateBaseline = executionEvidence({
      role: "baseline",
      sourceHash: BASELINE_HASH,
      hostMonotonicBaseUs: 30_000_000,
      samples: [
        { simulationTimeUs: 10_000, waitTimeSeconds: 0.001, spawnOrdinal: 1 },
        { simulationTimeUs: 20_000, waitTimeSeconds: 0.001, spawnOrdinal: 2 },
      ],
    });

    expect(() =>
      selectM5ExecutionEvidenceV1({
        taskId,
        taskSpec,
        patchIdentity: patchIdentity(),
        executions: [candidate(), lateBaseline],
      }),
    ).toThrow(/candidate must begin after the selected baseline/iu);
  });

  it("rejects a candidate that starts before the decisive baseline reproduction observation", () => {
    const overlappingBaseline = executionEvidence({
      role: "baseline",
      sourceHash: BASELINE_HASH,
      hostMonotonicBaseUs: 10_000_000,
      samples: [
        { simulationTimeUs: 10_000, waitTimeSeconds: 0.001, spawnOrdinal: 0 },
        {
          simulationTimeUs: 200_000,
          waitTimeSeconds: 0.001,
          spawnOrdinal: 1,
        },
      ],
    });
    const overlappingCandidate = executionEvidence({
      role: "candidate",
      sourceHash: CANDIDATE_HASH,
      hostMonotonicBaseUs: 10_100_000,
      samples: [
        { simulationTimeUs: 10_000, waitTimeSeconds: 1, spawnOrdinal: 0 },
        { simulationTimeUs: 200_000, waitTimeSeconds: 1, spawnOrdinal: 0 },
        {
          simulationTimeUs: 100_010_000,
          waitTimeSeconds: 1,
          spawnOrdinal: 1,
        },
        {
          simulationTimeUs: 100_100_000,
          waitTimeSeconds: 1,
          spawnOrdinal: 1,
        },
      ],
    });

    expect(overlappingBaseline.events[0]!.hostMonotonicStartUs).toBeLessThan(
      overlappingCandidate.events[0]!.hostMonotonicStartUs,
    );
    expect(overlappingBaseline.events[1]!.hostMonotonicEndUs).toBeGreaterThan(
      overlappingCandidate.events[0]!.hostMonotonicStartUs,
    );
    expect(() =>
      selectM5ExecutionEvidenceV1({
        taskId,
        taskSpec,
        patchIdentity: patchIdentity(),
        executions: [overlappingBaseline, overlappingCandidate],
      }),
    ).toThrow(/baseline behavior reproduction/iu);
  });

  it("allows a sealed failed intermediate launch before the successful final candidate", () => {
    const intermediate = executionEvidence({
      role: "intermediate",
      sourceHash: "d".repeat(64),
      samples: [
        { simulationTimeUs: 10_000, waitTimeSeconds: 1, spawnOrdinal: 0 },
        { simulationTimeUs: 20_000, waitTimeSeconds: 1, spawnOrdinal: 0 },
      ],
    });

    const selected = selectM5ExecutionEvidenceV1({
      taskId,
      taskSpec,
      patchIdentity: patchIdentity(),
      executions: [
        baseline(),
        {
          ...intermediate,
          runtime: { ...intermediate.runtime, status: "failed" },
        },
        candidate(),
      ],
    });

    expect(selected.totalExecutionCount).toBe(3);
    expect(selected.candidate.build.sourceHash).toBe(CANDIDATE_HASH);
  });

  it("selects a successful final-source run after a sealed failed run of the same source", () => {
    const failed = executionEvidence({
      role: "candidate",
      identitySuffix: "-failed",
      sourceHash: CANDIDATE_HASH,
      hostMonotonicBaseUs: 15_000_000,
      samples: [
        { simulationTimeUs: 10_000, waitTimeSeconds: 1, spawnOrdinal: 0 },
        { simulationTimeUs: 20_000, waitTimeSeconds: 1, spawnOrdinal: 0 },
      ],
    });
    const selected = selectM5ExecutionEvidenceV1({
      taskId,
      taskSpec,
      patchIdentity: patchIdentity(),
      executions: [
        baseline(),
        {
          ...failed,
          runtime: { ...failed.runtime, status: "failed" },
        },
        candidate(),
      ],
    });

    expect(selected.totalExecutionCount).toBe(3);
    expect(selected.candidate.build.sourceHash).toBe(CANDIDATE_HASH);
  });

  it("rejects corrupted lineage even on a sealed failed intermediate launch", () => {
    const intermediate = executionEvidence({
      role: "intermediate",
      sourceHash: "d".repeat(64),
      samples: [
        { simulationTimeUs: 10_000, waitTimeSeconds: 1, spawnOrdinal: 0 },
      ],
    });
    const event = intermediate.events[0]!;

    expect(() =>
      selectM5ExecutionEvidenceV1({
        taskId,
        taskSpec,
        patchIdentity: patchIdentity(),
        executions: [
          baseline(),
          {
            ...intermediate,
            runtime: { ...intermediate.runtime, status: "failed" },
            events: [
              {
                ...event,
                projectionSha256: event.projectionSha256.replace(
                  /^./u,
                  event.projectionSha256.startsWith("e") ? "f" : "e",
                ) as typeof event.projectionSha256,
              },
            ],
          },
          candidate(),
        ],
      }),
    ).toThrow(/projection hash/iu);
  });

  it("rejects a sealed stopped execution without a terminal shutdown", () => {
    const intermediate = executionEvidence({
      role: "intermediate",
      sourceHash: "d".repeat(64),
      samples: [
        { simulationTimeUs: 10_000, waitTimeSeconds: 1, spawnOrdinal: 0 },
      ],
    });

    expect(() =>
      selectM5ExecutionEvidenceV1({
        taskId,
        taskSpec,
        patchIdentity: patchIdentity(),
        executions: [baseline(), intermediate, candidate()],
      }),
    ).toThrow(/does not end with shutdown/iu);
  });

  it("rejects a semantic ledger whose clocks move backward", () => {
    const clean = candidate();
    const event = clean.events[1]!;
    const regressedProjection = {
      ...event.projection,
      capturedAt: {
        ...event.projection.capturedAt,
        simulationTimeUs: 5_000,
        processFrame: 0,
        physicsTick: 0,
      },
    };
    const regressed = {
      ...clean,
      events: clean.events.map((candidateEvent, index) =>
        index === 1
          ? VNextSemanticObservationEventV1Schema.parse({
              ...candidateEvent,
              projection: regressedProjection,
              projectionSha256: contentHash(regressedProjection),
            })
          : candidateEvent,
      ),
    };
    expect(() =>
      selectM5ExecutionEvidenceV1({
        taskId,
        taskSpec,
        patchIdentity: patchIdentity(),
        executions: [baseline(), regressed],
      }),
    ).toThrow(/final-candidate/iu);
  });

  it("requires a nonempty full-index patch and tracked non-addon GDScript", () => {
    const bytes = Buffer.from(
      [
        "diff --git a/components/spawner/spawner_broken.gd b/components/spawner/spawner_broken.gd",
        `index ${"1".repeat(40)}..${"2".repeat(40)} 100644`,
        "--- a/components/spawner/spawner_broken.gd",
        "+++ b/components/spawner/spawner_broken.gd",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
    );
    const hash = sha256Bytes(bytes);
    const identity = TaskPatchIdentityV1Schema.parse({
      ...patchIdentity(),
      patchId: `patch:v1:${hash}`,
      patchHash: hash,
      byteLength: bytes.byteLength,
    });
    expect(() =>
      requireM5PatchExportV1({
        taskId,
        identity,
        bytes,
        receipt: {
          schemaVersion: 1,
          taskId,
          patchId: identity.patchId,
          patchSha256: hash,
          outputPath: "candidate.patch",
          byteLength: bytes.byteLength,
          exportedAt: "2026-08-12T00:00:00.000Z",
          status: "completed",
        },
      }),
    ).not.toThrow();
    expect(
      requireM5TrackedGdPathsV1(
        ["components/spawner/spawner_broken.gd"],
        taskSpec.patchContract,
      ),
    ).toEqual(["components/spawner/spawner_broken.gd"]);
    expect(() =>
      requireM5TrackedGdPathsV1(
        ["addons/chronorift/semantic_probe.gd"],
        taskSpec.patchContract,
      ),
    ).toThrow(/tracked .gd/iu);
    expect(() =>
      requireM5TrackedGdPathsV1(["README.md"], taskSpec.patchContract),
    ).toThrow(/tracked .gd/iu);
    expect(() =>
      requireM5TrackedGdPathsV1(
        ["components/./spawner/enemy_spawner_broken.gd"],
        taskSpec.patchContract,
      ),
    ).toThrow(/tracked .gd/iu);
  });

  it("binds cleanup facts to the Task and candidate", () => {
    const selection = selectM5ExecutionEvidenceV1({
      taskId,
      taskSpec,
      patchIdentity: patchIdentity(),
      executions: [baseline(), candidate()],
    });
    const receipt = createM5CleanupReceiptV1({
      taskId,
      taskSpecSha256: sha256Bytes(Buffer.from("spec")),
      patchIdentity: patchIdentity(),
      selection,
      cleanup: {
        processGroupTerminated: true,
        cgroupPopulated: false,
        termSent: true,
        killSent: false,
        scopeRemoved: true,
        storageReconciled: true,
      },
      taskRootRemoved: true,
      postDiscardIsolation: {
        boundedTaskStorageEmpty: true,
        taskCgroupLeavesEmpty: true,
      },
      sourceUnchanged: true,
    });
    expect(receipt).toMatchObject({
      taskId,
      patchId: `patch:v1:${HASH}`,
      candidateSourceHash: CANDIDATE_HASH,
      taskRootRemoved: true,
      boundedTaskStorageEmpty: true,
      taskCgroupLeavesEmpty: true,
    });
  });

  it("accepts realized aggregate storage when per-operation reconciliation is omitted", async () => {
    const { runtimeRoot } = await sandboxRealizationHarness();

    await expect(
      readM5SandboxRealizationV1({ runtimeRoot, taskId }),
    ).resolves.toMatchObject({ operationCount: 1 });
  });

  it("rejects an explicitly unreconciled sandbox operation", async () => {
    const { runtimeRoot } = await sandboxRealizationHarness({
      storageReconciled: false,
    });

    await expect(
      readM5SandboxRealizationV1({ runtimeRoot, taskId }),
    ).rejects.toThrow(/sandbox realization is incomplete/iu);
  });

  it("rejects a sandbox operation without aggregate storage observation", async () => {
    const { runtimeRoot } = await sandboxRealizationHarness({
      observeAggregateStorage: false,
      storageReconciled: true,
    });

    await expect(
      readM5SandboxRealizationV1({ runtimeRoot, taskId }),
    ).rejects.toThrow(/sandbox realization is incomplete/iu);
  });

  it("rejects a sandbox operation from a different persisted policy", async () => {
    const { runtimeRoot } = await sandboxRealizationHarness({
      receiptPolicyId: `sandbox-policy:v1:${"b".repeat(64)}`,
    });

    await expect(
      readM5SandboxRealizationV1({ runtimeRoot, taskId }),
    ).rejects.toThrow(/sandbox realization is incomplete/iu);
  });

  it("creates strict content-bound summary and fourteen-artifact manifest", () => {
    const reference = (relativePath: string) => ({
      relativePath,
      rawSha256: sha256Bytes(Buffer.from(relativePath)),
    });
    const runtimeReferences = (role: "baseline" | "candidate") => ({
      build: reference(`runtime-records/${role}/build.json`),
      runtime: reference(`runtime-records/${role}/runtime.json`),
      execution: reference(`runtime-records/${role}/execution.json`),
      events: reference(`runtime-records/${role}/events.jsonl`),
      executionSeal: reference(`runtime-records/${role}/execution-seal.json`),
    });
    const runtimeArtifacts = {
      baseline: runtimeReferences("baseline"),
      candidate: runtimeReferences("candidate"),
    };
    const patchArtifact = reference("candidate.patch");
    const exportReceiptArtifact = reference("patch-export-receipt.json");
    const cleanupArtifact = reference("cleanup-receipt.json");
    const productSubject = {
      repositoryCommit: "d".repeat(40),
      repositoryTree: "e".repeat(40),
      clean: true as const,
    };
    const summary = createM5EvidenceSummaryV1({
      taskSpec,
      taskSpecSha256: M5_TASK_SPEC_RAW_SHA256_V1,
      taskId,
      agent: {
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        thinkingLevel: "max",
        attemptOrdinal: 1,
        turnCount: 1,
        loopStatus: "completed",
        requestedTaskSandboxNetworkMode: "denied",
        hostModelNetworkPolicy: "provider_only",
        taskCredentialMountCountMaximum: 0,
        totalToolCallCount: 4,
        activeTools: [
          "read",
          "bash",
          "edit",
          "write",
          "grep",
          "find",
          "ls",
          ...SEMANTIC_GAME_TOOL_NAMES_V1,
        ],
      },
      productSubject,
      patchIdentity: patchIdentity(),
      patchArtifact,
      exportReceiptArtifact,
      changedPaths: ["components/spawner/enemy_spawner_broken.gd"],
      runtimeArtifacts,
      cleanupArtifact,
    });
    const { summaryContentSha256, ...summaryBasis } = summary;
    expect(summaryContentSha256).toBe(contentHash(summaryBasis as never));
    const summaryArtifact = {
      relativePath: "summary.json",
      rawSha256: sha256Bytes(
        Buffer.from(`${canonicalJson(summary as never)}\n`, "utf8"),
      ),
    };
    const manifest = createM5EvidenceManifestV1({
      taskSpecSha256: M5_TASK_SPEC_RAW_SHA256_V1,
      taskId,
      productSubject,
      artifacts: [
        patchArtifact,
        cleanupArtifact,
        exportReceiptArtifact,
        runtimeArtifacts.baseline.build,
        runtimeArtifacts.baseline.runtime,
        runtimeArtifacts.baseline.execution,
        runtimeArtifacts.baseline.events,
        runtimeArtifacts.baseline.executionSeal,
        runtimeArtifacts.candidate.build,
        runtimeArtifacts.candidate.runtime,
        runtimeArtifacts.candidate.execution,
        runtimeArtifacts.candidate.events,
        runtimeArtifacts.candidate.executionSeal,
        summaryArtifact,
      ],
    });
    const { manifestContentSha256, ...manifestBasis } = manifest;
    expect(manifestContentSha256).toBe(contentHash(manifestBasis as never));
    expect(manifest.artifacts).toHaveLength(14);
  });

  it("writes create-new canonical JSON artifacts with one trailing LF", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-m5-json-unit-"));
    temporaryRoots.push(root);
    const value = { z: 1, nested: { second: true, first: false }, a: 2 };
    const reference = await writeM5CanonicalArtifactV1({
      stagingRoot: root,
      relativePath: "summary.json",
      value,
    });
    const bytes = await readFile(join(root, "summary.json"));
    expect(bytes.toString("utf8")).toBe(`${canonicalJson(value)}\n`);
    expect(reference.rawSha256).toBe(sha256Bytes(bytes));
    await expect(
      writeM5CanonicalArtifactV1({
        stagingRoot: root,
        relativePath: "summary.json",
        value,
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("removes only the owned bounded scratch directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "chronorift-m5-owned-unit-"));
    temporaryRoots.push(parent);
    const owned = await createM5OwnedTemporaryDirectoryV1(parent, "runtime");
    await writeFile(join(owned.root, "record"), "owned");
    await removeM5OwnedTemporaryDirectoryV1(owned);
    await expect(readFile(join(owned.root, "record"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const stale = await createM5OwnedTemporaryDirectoryV1(parent, "agent");
    await rm(stale.root, { recursive: true });
    await mkdir(stale.root);
    await expect(removeM5OwnedTemporaryDirectoryV1(stale)).rejects.toThrow(
      /identity/iu,
    );
  });

  it("always removes unpublished staging and aggregates independent failures", async () => {
    const calls: string[] = [];
    const primary = new Error("provider failed");
    const discard = new Error("discard failed");
    const staging = new Error("staging failed");
    let observed: unknown;
    try {
      await finalizeM5OwnershipV1({
        primaryFailure: primary,
        taskMayExist: true,
        taskDiscarded: false,
        published: false,
        discard: async () => {
          calls.push("discard");
          throw discard;
        },
        removeRuntime: async () => {
          calls.push("runtime");
        },
        removeAgent: async () => {
          calls.push("agent");
        },
        removeStaging: async () => {
          calls.push("staging");
          throw staging;
        },
      });
    } catch (error) {
      observed = error;
    }
    expect(calls).toEqual(["discard", "agent", "staging"]);
    expect(observed).toBeInstanceOf(AggregateError);
    expect((observed as AggregateError).errors).toEqual([
      primary,
      discard,
      staging,
    ]);
  });

  it("does not remove a successfully published staging root", async () => {
    const calls: string[] = [];
    await finalizeM5OwnershipV1({
      taskMayExist: false,
      taskDiscarded: true,
      published: true,
      removeStaging: async () => {
        calls.push("staging");
      },
    });
    expect(calls).toEqual([]);
  });

  it("cleans scratch and staging acquired before a setup failure", async () => {
    const calls: string[] = [];
    await expect(
      finalizeM5OwnershipV1({
        primaryFailure: new Error("setup failed"),
        taskMayExist: false,
        taskDiscarded: false,
        published: false,
        removeRuntime: async () => {
          calls.push("runtime");
        },
        removeAgent: async () => {
          calls.push("agent");
        },
        removeStaging: async () => {
          calls.push("staging");
        },
      }),
    ).rejects.toThrow("setup failed");
    expect(calls).toEqual(["agent", "runtime", "staging"]);
  });

  it("requires empty bounded storage and an unpopulated leaf-free cgroup", async () => {
    const parent = await mkdtemp(join(tmpdir(), "chronorift-m5-empty-unit-"));
    temporaryRoots.push(parent);
    const storage = join(parent, "storage");
    const cgroup = join(parent, "cgroup");
    await Promise.all([mkdir(storage), mkdir(cgroup)]);
    await writeFile(join(cgroup, "cgroup.events"), "populated 0\nfrozen 0\n");
    await expect(
      requireM5PostDiscardIsolationV1({
        taskStorageRoot: storage,
        taskCgroupRoot: cgroup,
      }),
    ).resolves.toEqual({
      boundedTaskStorageEmpty: true,
      taskCgroupLeavesEmpty: true,
    });
    await mkdir(join(cgroup, "stale-leaf"));
    await expect(
      requireM5PostDiscardIsolationV1({
        taskStorageRoot: storage,
        taskCgroupRoot: cgroup,
      }),
    ).rejects.toThrow(/not empty/iu);
  });

  it("publishes only its create-new staging directory and refuses stale ownership", async () => {
    const parent = await mkdtemp(join(tmpdir(), "chronorift-m5-stage-unit-"));
    temporaryRoots.push(parent);
    const finalRoot = join(parent, "bundle");
    const ownership = await createM5StagingRootV1(finalRoot);
    await writeFile(join(ownership.stagingRoot, "evidence"), "ok", {
      flag: "wx",
    });
    await publishM5StagingRootV1(ownership);
    expect(await readFile(join(finalRoot, "evidence"), "utf8")).toBe("ok");

    const second = await createM5StagingRootV1(join(parent, "second"));
    await rm(second.stagingRoot, { recursive: true });
    await mkdir(second.stagingRoot);
    await expect(removeM5StagingRootV1(second)).rejects.toThrow(/identity/iu);
  });

  it("rejects an already-published final root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "chronorift-m5-final-unit-"));
    temporaryRoots.push(parent);
    const finalRoot = join(parent, "bundle");
    await mkdir(finalRoot);
    await expect(createM5StagingRootV1(finalRoot)).rejects.toThrow(
      /already exists/iu,
    );
  });

  it("keeps the task spec schema strict", () => {
    expect(() =>
      M5TaskSpecV1Schema.parse({ ...taskSpec, accepted: true }),
    ).toThrow();
  });
});
