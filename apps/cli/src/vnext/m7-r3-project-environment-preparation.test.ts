import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JsonValueSchema,
  M6AdapterBuildCompatibilityReceiptV1Schema,
  PROJECT_CAPABILITY_MODULE_NAMES_V1,
  ProjectAdapterRevisionV1Schema,
  ProjectEnvironmentRuntimeObservationReceiptV1Schema,
  asSha256DigestV1,
  asSourceId,
  type JsonValue,
  type M6AdapterBuildCompatibilityLineageV1,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExternalHiddenFixPublicTaskSpecV1Schema } from "./external-hidden-fix-assignment.js";
import {
  M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1,
  createM7R3PatrolTrajectoryCaseSpecV1,
} from "./m7-patrol-trajectory.js";
import {
  M7R3AgentDeliveryTraceV1Schema,
  createM7R3AgentDeliveryTrackerV1,
} from "./m7-r3-agent-delivery.js";
import { createM7R3CaseCampaignAdmissionV1 } from "./m7-r3-case-admission.js";
import {
  M7_R3_NEUTRAL_ENVIRONMENT_INSTRUCTIONS_SHA256_V1,
  M7R3AgentVisibleGameToolExchangeReceiptV1Schema,
  M7R3EvaluatorHeadroomReceiptV1Schema,
  M7R3RuntimeEvidenceReceiptV1Schema,
  M7R3TaskStorageHeadroomReceiptV1Schema,
  createM7R3TaskStorageHeadroomReceiptV1,
  createM7R3RuntimeEvidenceReceiptV1,
} from "./m7-r3-project-environment-paired-agent.js";
import {
  M7R3ProjectEnvironmentPreparationInfrastructureErrorV1,
  cleanupM7R3FailedPreparationResourcesV1,
  openM7R3DurableRecordStoreV1,
  prepareM7R3CodeOnlyTaskFromM6RuntimeTaskV1,
  prepareM7R3ProjectEnvironmentInfrastructureV1,
  prepareM7R3RuntimeSurfaceFromM6TaskV1,
  reopenM7R3DurableRecordStoreV1,
  type M7R3ImmutableRecordWriterV1,
} from "./m7-r3-project-environment-preparation.js";
import { ProjectEnvironmentPreparationInfrastructureErrorV1 } from "./preparation-resource-owner.js";
import {
  createM7R3NaturalUserPromptV1,
  createM7R3PairedAgentProtocolV1,
  createM7R3PairedCaseContractV1,
} from "./m7-r3-paired-agent.js";
import { M7R3LocalArmAdmissionV1Schema } from "./m7-r3-runtime-use-local-gate.js";
import { createM7R3TwoCasePortfolioFreezeV1 } from "./m7-r3-two-case-portfolio.js";
import { deriveM7BuildSourceIdentitySha256V1 } from "./m7-runtime-use-campaign.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const sha = (value: string | Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));

const shaJson = (value: unknown): Sha256DigestV1 =>
  sha(canonicalJson(JsonValueSchema.parse(value)));

const sandboxCleanupReceipt = {
  processGroupTerminated: true,
  cgroupPopulated: false,
  termSent: false,
  killSent: false,
  scopeRemoved: true,
  storageReconciled: true,
} as const;

const taskStorageHeadroom = {
  schemaVersion: 1,
  availableBytes: 512 * 1024 * 1024,
  availableInodes: 65_536,
  requiredAvailableBytes: 256 * 1024 * 1024,
  requiredAvailableInodes: 16_384,
} as const;

const ownershipPublicTask = (taskId: string) =>
  ExternalHiddenFixPublicTaskSpecV1Schema.parse({
    schemaVersion: 1,
    taskKind: "external-hidden-fix",
    taskId,
    subjectCommit: "1".repeat(40),
    goal: "修复敌人移动问题。",
    publicExecutionClassifier: {
      schemaVersion: 1,
      classifierId: "m7-r3-generic-patrol",
      implementationSha256: sha("ownership classifier"),
    },
    agentBudget: {
      provider: "test-provider",
      model: "test-model",
      thinkingLevel: "high",
      attemptsMaximum: 1,
      userTurnsPerAttemptMaximum: 1,
      toolCallsMaximum: 64,
      wallTimeMsMaximum: 900_000,
      taskSandboxNetworkMode: "denied",
      taskCredentialMountCountMaximum: 0,
    },
    evaluatorBudget: {
      scenarioClasses: [
        "public_reproduction",
        "hidden_variant",
        "regression_control",
      ],
      repetitionsPerScenario: 3,
      plannedRunCount: 9,
      evaluatorProcessAttemptsPerRunMaximum: 1,
      freshWorkspacePerRun: true,
      freshImportCachePerRun: true,
      freshEvaluatorProcessPerRun: true,
      agentRelaunchCountMaximum: 0,
      wallTimeMsPerRunMaximum: 60_000,
    },
  });

const cleanup = {
  schemaVersion: 1 as const,
  processTreeTerminated: true,
  runtimeExited: true,
  bridgeExited: true,
  isolationGroupEmpty: true,
  scopeRemoved: true,
  scratchRemoved: true,
  storageReconciled: true,
};

const coverage = [
  {
    schemaVersion: 1 as const,
    channelId: "patrol.motion",
    status: "complete" as const,
    observedRecords: 3,
    droppedRecords: 0,
    overwrittenRecords: 0,
    limitations: [],
  },
];

const adapterRevision = ProjectAdapterRevisionV1Schema.parse({
  schemaVersion: 1,
  adapterRevisionId: "adapter-revision:m7-r3:generic-patrol",
  adapterId: "adapter:m7-r3:generic-patrol",
  sourceId: asSourceId(`source:v1:${sha("pristine source")}`),
  packageDigest: sha("canonical Adapter package manifest"),
  manifestDigest: sha("Adapter manifest"),
  implementationDigest: sha("generic implementation"),
  payloadSchemaDigest: sha("canonical generic patrol schema"),
  sdkDigest: sha("Adapter SDK"),
  bridgeDigest: sha("Adapter bridge"),
  capabilitySet: {
    schemaVersion: 1,
    modules: PROJECT_CAPABILITY_MODULE_NAMES_V1.map((module) => ({
      schemaVersion: 1,
      module,
      status: "implemented" as const,
      protocolVersion: "project-environment-v1",
      limitations: [],
    })),
  },
  conformanceReceiptId: "conformance:m7-r3:generic-patrol",
  contentByteLength: 4_096,
  contentFileCount: 4,
});

const makeLayout = async (root: string, name: string) => {
  const base = join(root, name);
  const workspaceDirectory = join(base, "workspace");
  const taskRecordDirectory = join(base, "records", "task");
  const runtimeRecordDirectory = join(base, "records", "runtime");
  const piSessionDirectory = join(base, "session");
  const hostBaselineGitDirectory = join(base, "baseline.git");
  const hostOperationTemporaryDirectory = join(base, "host-tmp");
  const sandboxTemporaryDirectory = join(base, "tmp");
  const sandboxArtifactScratchDirectory = join(base, "artifacts");
  const projectEnvironmentRecordDirectory = join(base, "project-records");
  await Promise.all(
    [
      workspaceDirectory,
      taskRecordDirectory,
      runtimeRecordDirectory,
      piSessionDirectory,
      hostBaselineGitDirectory,
      hostOperationTemporaryDirectory,
      sandboxTemporaryDirectory,
      sandboxArtifactScratchDirectory,
      projectEnvironmentRecordDirectory,
    ].map((path) => mkdir(path, { recursive: true })),
  );
  return {
    taskRootDirectory: base,
    workspaceDirectory,
    taskRecordDirectory,
    runtimeRecordDirectory,
    piSessionDirectory,
    hostBaselineGitDirectory,
    hostOperationTemporaryDirectory,
    sandboxTemporaryDirectory,
    sandboxArtifactScratchDirectory,
    projectEnvironmentRecordDirectory,
  };
};

describe("M7 R3 production Project Environment preparation", () => {
  it("cleans the transferred runtime broker when pre-validation fails", async () => {
    const runtimeCleanup = vi.fn(async () => sandboxCleanupReceipt);

    const failure = await prepareM7R3ProjectEnvironmentInfrastructureV1({
      runtimeTask: {
        publicTask: { schemaVersion: 999 },
        broker: { cleanup: runtimeCleanup },
      },
    } as never).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(
      M7R3ProjectEnvironmentPreparationInfrastructureErrorV1,
    );
    expect(failure).toMatchObject({
      cleanup: {
        cleanupProven: true,
        sandboxSafetyFailure: false,
      },
    });
    expect(
      (failure as M7R3ProjectEnvironmentPreparationInfrastructureErrorV1)
        .cleanup.cleanupReceiptSha256,
    ).not.toBeNull();
    expect(runtimeCleanup).toHaveBeenCalledTimes(1);
  });

  it("keeps a real preparation cleanup failure unproven", async () => {
    const runtimeCleanup = vi.fn(async () => ({
      ...sandboxCleanupReceipt,
      scopeRemoved: false,
    }));
    const failure = await prepareM7R3ProjectEnvironmentInfrastructureV1({
      runtimeTask: {
        publicTask: { schemaVersion: 999 },
        broker: { cleanup: runtimeCleanup },
      },
    } as never).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(
      M7R3ProjectEnvironmentPreparationInfrastructureErrorV1,
    );
    expect(failure).toMatchObject({
      cleanup: {
        cleanupProven: false,
        cleanupReceiptSha256: null,
      },
    });
    expect((failure as Error).cause).toBeInstanceOf(AggregateError);
  });

  it("cleans the transferred runtime broker when durable-store open fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-m7-r3-owned-"));
    roots.push(root);
    const runtimeCache = join(root, "runtime-cache");
    const runtimeSession = join(root, "runtime-session");
    const codeOnlyDurableRoot = join(root, "code-only-durable");
    await Promise.all(
      [runtimeCache, runtimeSession, codeOnlyDurableRoot].map((path) =>
        mkdir(path, { mode: 0o700 }),
      ),
    );
    const runtimePublicTask = ownershipPublicTask("task:m7-r3:owned-runtime");
    const codeOnlyPublicTask = ownershipPublicTask(
      "task:m7-r3:owned-code-only",
    );
    const runtimeCleanup = vi.fn(async () => sandboxCleanupReceipt);
    const trajectoryCaseSpec = createM7R3PatrolTrajectoryCaseSpecV1({
      classifierImplementationSha256: sha("ownership classifier"),
      expectedBaselineWitnessKinds: ["ground_contact_loss"],
      expectedRecoveryWitnessKinds: ["direction_recovery"],
      frozenAt: "2026-08-16T00:00:00.000Z",
    });

    const failure = await prepareM7R3ProjectEnvironmentInfrastructureV1({
      runtimeTask: {
        taskId: runtimePublicTask.taskId,
        publicTask: runtimePublicTask,
        agentDir: runtimeCache,
        layout: { piSessionDirectory: runtimeSession },
        broker: { cleanup: runtimeCleanup },
      } as never,
      codeOnlyPublicTask,
      codeOnlyPublicTaskSpecSha256: shaJson(codeOnlyPublicTask),
      codeOnlyPatchStore: {} as never,
      runtimeAgentResourceDirectory: runtimeCache,
      codeOnlyAgentResourceDirectory: join(root, "code-only-cache"),
      runtimeDurableRecordRoot: join(root, "missing-runtime-durable"),
      codeOnlyDurableRecordRoot: codeOnlyDurableRoot,
      trajectoryClassifierConfig: M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1,
      trajectoryCaseSpec,
      hostModelRuntimeConfigSha256: sha("owned Host model config"),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(
      M7R3ProjectEnvironmentPreparationInfrastructureErrorV1,
    );
    expect(failure).toMatchObject({
      cleanup: { cleanupProven: true },
    });
    expect(runtimeCleanup).toHaveBeenCalledTimes(1);
  });

  it("uses typed nested code-only owner cleanup without re-cleaning its task", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-m7-r3-nested-"));
    roots.push(root);
    const runtimeCache = join(root, "runtime-cache");
    const codeOnlyCache = join(root, "code-only-cache");
    const runtimeSession = join(root, "runtime-session");
    const runtimeDurableRoot = join(root, "runtime-durable");
    const codeOnlyDurableRoot = join(root, "code-only-durable");
    await Promise.all(
      [
        runtimeCache,
        codeOnlyCache,
        runtimeSession,
        runtimeDurableRoot,
        codeOnlyDurableRoot,
      ].map((path) => mkdir(path, { mode: 0o700 })),
    );
    const runtimePublicTask = ownershipPublicTask("task:m7-r3:nested-runtime");
    const codeOnlyPublicTask = ownershipPublicTask(
      "task:m7-r3:nested-code-only",
    );
    const runtimeCleanup = vi.fn(async () => sandboxCleanupReceipt);
    const nested = new ProjectEnvironmentPreparationInfrastructureErrorV1(
      "m7-r3-code-only:broker",
      {
        schemaVersion: 1,
        sandboxCleanupKind: "broker",
        sandboxCleanupRequired: true,
        sandboxCleanupAttempted: true,
        sandboxCleanupReceiptObserved: true,
        sandboxCleanupComplete: true,
        taskRootRemovalAttempted: true,
        taskRootRemoved: true,
        cleanupProven: true,
      },
      new Error("nested code-only preparation failed"),
    );
    const prepareCodeOnlyTask = vi.fn(async () => {
      throw nested;
    });
    const trajectoryCaseSpec = createM7R3PatrolTrajectoryCaseSpecV1({
      classifierImplementationSha256: sha("nested classifier"),
      expectedBaselineWitnessKinds: ["ground_contact_loss"],
      expectedRecoveryWitnessKinds: ["direction_recovery"],
      frozenAt: "2026-08-16T00:00:00.000Z",
    });

    const failure = await prepareM7R3ProjectEnvironmentInfrastructureV1(
      {
        runtimeTask: {
          taskId: runtimePublicTask.taskId,
          publicTask: runtimePublicTask,
          agentDir: runtimeCache,
          layout: { piSessionDirectory: runtimeSession },
          broker: { cleanup: runtimeCleanup },
        } as never,
        codeOnlyPublicTask,
        codeOnlyPublicTaskSpecSha256: shaJson(codeOnlyPublicTask),
        codeOnlyPatchStore: {} as never,
        runtimeAgentResourceDirectory: runtimeCache,
        codeOnlyAgentResourceDirectory: codeOnlyCache,
        runtimeDurableRecordRoot: runtimeDurableRoot,
        codeOnlyDurableRecordRoot: codeOnlyDurableRoot,
        trajectoryClassifierConfig: M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1,
        trajectoryCaseSpec,
        hostModelRuntimeConfigSha256: sha("nested Host model config"),
      },
      { prepareCodeOnlyTask: prepareCodeOnlyTask as never },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(
      M7R3ProjectEnvironmentPreparationInfrastructureErrorV1,
    );
    expect(failure).toMatchObject({
      cleanup: {
        cleanupProven: true,
        sandboxSafetyFailure: false,
      },
      cause: nested,
    });
    expect(
      (failure as M7R3ProjectEnvironmentPreparationInfrastructureErrorV1)
        .cleanup.cleanupReceiptSha256,
    ).not.toBeNull();
    expect(prepareCodeOnlyTask).toHaveBeenCalledOnce();
    expect(runtimeCleanup).toHaveBeenCalledOnce();
  });

  it("includes an acquired runtime surface in failed-preparation cleanup truth", async () => {
    const order: string[] = [];
    const runtimeCleanup = vi.fn(async () => {
      order.push("runtime-broker");
      return sandboxCleanupReceipt;
    });
    const surfaceClose = vi.fn(async () => {
      order.push("runtime-surface");
    });
    const result = await cleanupM7R3FailedPreparationResourcesV1({
      runtimeBroker: { cleanup: runtimeCleanup } as never,
      runtimePrepared: { surface: { close: surfaceClose } } as never,
      codeOnlyPreparationStarted: false,
      runtimeSurfacePreparationStarted: true,
      error: new Error("post-surface validation failed"),
    });
    expect(result.cleanup.cleanupProven).toBe(true);
    expect(result.cleanup.cleanupReceiptSha256).not.toBeNull();
    expect(surfaceClose).toHaveBeenCalledOnce();
    expect(runtimeCleanup).toHaveBeenCalledOnce();
    expect(order).toEqual(["runtime-surface", "runtime-broker"]);
  });

  it("round-trips strict delivery/runtime records by logical self-hash and full canonical hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-m7-r3-durable-"));
    roots.push(root);
    const durableRoot = join(root, "records");
    await mkdir(durableRoot, { mode: 0o700 });
    const records = await openM7R3DurableRecordStoreV1({
      root: durableRoot,
      taskId: "task:m7-r3:runtime",
    });
    const trace = createM7R3AgentDeliveryTrackerV1().snapshot();
    const responseDetails = JsonValueSchema.parse({
      schemaVersion: 1,
      toolCallId: "query:m7-r3:one",
      outcome: "error",
      error: { code: "not_started", message: "runtime was not started" },
    });
    const finalToolResult = JsonValueSchema.parse({
      content: [{ type: "text", text: "runtime was not started" }],
      details: responseDetails,
    });
    const exchangeBasis = {
      schemaVersion: 1 as const,
      recordKind: "m7-r3-agent-visible-game-tool-exchange-receipt" as const,
      ordinal: 1,
      toolCallId: "query:m7-r3:one",
      toolName: "game_query",
      input: JsonValueSchema.parse({
        schemaVersion: 1,
        taskId: "task:m7-r3:runtime",
        executionId: "execution:m7-r3:one",
        select: "state",
        limit: 10,
      }),
      responseDetails,
      responseDetailsSha256: shaJson(responseDetails),
      finalToolResult,
      finalToolResultSha256: shaJson(finalToolResult),
      outputIdentity: null,
      observedAt: "2026-08-16T00:00:00.000Z",
      hostToolReturnOrdinal: 1,
    };
    const exchange = M7R3AgentVisibleGameToolExchangeReceiptV1Schema.parse({
      ...exchangeBasis,
      recordContentSha256: shaJson(exchangeBasis),
    });
    const transcript = [
      {
        schemaVersion: 1 as const,
        ordinal: exchange.ordinal,
        toolCallId: exchange.toolCallId,
        toolName: exchange.toolName,
        input: exchange.input,
        response: exchange.responseDetails,
        observedAt: exchange.observedAt,
        hostToolReturnOrdinal: exchange.hostToolReturnOrdinal,
      },
    ];
    const runtimeEvidence = createM7R3RuntimeEvidenceReceiptV1({
      schemaVersion: 1,
      recordKind: "m7-r3-runtime-agent-evidence-receipt",
      campaignId: "m7-campaign:111111111111111111111111",
      portfolioId: "m7-r3-portfolio:111111111111111111111111",
      caseId: "m7-r3-case:111111111111111111111111",
      caseCampaignAdmissionRecordSha256: sha("case admission"),
      pairedCaseContractContentSha256: sha("paired contract"),
      attemptBindingContentSha256: sha("attempt binding"),
      arm: "runtime_enabled",
      attemptOrdinal: 1,
      baselineSelectedTreeSha256: sha("mutant baseline"),
      backendProjectionReceiptSha256: sha("backend projection"),
      exchangeTranscriptSha256: shaJson(transcript),
      exchanges: [exchange],
      agentDeliveryTrace: trace,
      sourceObservations: [],
      executions: [],
      trajectoryMaterials: [],
    });

    expect(trace.recordContentSha256).not.toBe(shaJson(trace));
    expect(runtimeEvidence.recordContentSha256).not.toBe(
      shaJson(runtimeEvidence),
    );
    await records.writeOnce(
      "agent-delivery-trace",
      JsonValueSchema.parse(trace),
      trace.recordContentSha256,
    );
    await records.writeOnce(
      "runtime-agent-evidence",
      JsonValueSchema.parse(runtimeEvidence),
      runtimeEvidence.recordContentSha256,
    );
    const simulatedTaskTmpfs = join(root, "simulated-task-storage");
    await mkdir(simulatedTaskTmpfs);
    await rm(simulatedTaskTmpfs, { recursive: true, force: true });
    const reopened = await reopenM7R3DurableRecordStoreV1({
      root: durableRoot,
      taskId: "task:m7-r3:runtime",
    });

    expect(
      M7R3AgentDeliveryTraceV1Schema.parse(
        await reopened.readOnce("agent-delivery-trace"),
      ),
    ).toEqual(trace);
    expect(
      M7R3RuntimeEvidenceReceiptV1Schema.parse(
        await reopened.readOnce("runtime-agent-evidence"),
      ),
    ).toEqual(runtimeEvidence);
  });

  it("creates a physically code-only broker with no managed runtime, Godot, or Adapter treatment", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-m7-r3-code-only-"));
    roots.push(root);
    const layout = await makeLayout(root, "code-only-task");
    const cache = join(root, "code-only-cache");
    const durableRoot = join(root, "durable-records");
    await Promise.all([mkdir(cache), mkdir(durableRoot, { mode: 0o700 })]);
    const baseline = sha("mutated baseline");
    let brokerOptions: Record<string, unknown> | undefined;
    const broker = {
      execute: vi.fn(),
      cleanup: vi.fn(async () => ({
        processGroupTerminated: true,
        cgroupPopulated: false,
        termSent: false,
        killSent: false,
        scopeRemoved: true,
        storageReconciled: true,
      })),
    };
    const runtimeTask = {
      taskId: "task:m7-r3:runtime",
      assignment: {
        assignment: { mutatedBaselineSelectedTreeSha256: baseline },
        mutatedSource: { repositoryRoot: join(root, "mutant-authority") },
      },
    };
    const durableRecords = await openM7R3DurableRecordStoreV1({
      root: durableRoot,
      taskId: "task:m7-r3:code-only",
    });

    const prepared = await prepareM7R3CodeOnlyTaskFromM6RuntimeTaskV1(
      {
        runtimeTask: runtimeTask as never,
        codeOnlyTaskId: "task:m7-r3:code-only",
        agentResourceDirectory: cache,
        durableRecords,
      },
      {
        readHostConfig: vi.fn(
          async () =>
            ({
              taskStorageRoot: join(root, "task-storage"),
              runtimeRoot: join(root, "runtime-root"),
              delegatedCgroupRoot: join(root, "cgroup"),
              bwrapPath: "/usr/bin/bwrap",
              prlimitPath: "/usr/bin/prlimit",
              busyboxPath: "/usr/bin/busybox",
              lddPath: "/usr/bin/ldd",
              bashPath: "/host/bin/bash",
              rgPath: "/host/bin/rg",
              findPath: "/host/bin/find",
              lsPath: "/host/bin/ls",
            }) as never,
        ),
        createRuntimeRoot: vi.fn(async () => join(root, "runtime-root")),
        preflightSandbox: vi.fn(
          async () =>
            ({
              kind: "supported",
              capability: {
                runtimeIdentity: sha("sandbox runtime"),
                taskStorage: {
                  kind: "dedicated-capacity-bounded-filesystem-v1",
                  filesystem: "tmpfs",
                  totalBytes: 1024 * 1024 * 1024,
                  totalInodes: 131_072,
                  rootIdentitySha256: sha("task storage"),
                },
              },
              binding: {
                kind: "fake-binding",
                taskStorageRoot: join(root, "task-storage"),
              },
            }) as never,
        ),
        createLayout: vi.fn(async () => layout as never),
        materializeWorkspace: vi.fn(
          async () =>
            ({
              workspaceDirectory: layout.workspaceDirectory,
              hostBaselineGitDirectory: layout.hostBaselineGitDirectory,
              hostBaselineCommit: "0".repeat(40),
              receipt: {
                schemaVersion: 1,
                selectedTreeSha256: baseline,
              },
            }) as never,
        ),
        inspectToolchain: vi.fn(
          async () =>
            ({
              capability: {
                toolchainId: `sandbox-toolchain:v1:${sha("ordinary coding toolchain")}`,
                files: [
                  { target: "/bin/bash" },
                  { target: "/usr/bin/rg" },
                  { target: "/usr/bin/find" },
                  { target: "/usr/bin/ls" },
                ],
              },
            }) as never,
        ),
        createBroker: vi.fn(async (options) => {
          brokerOptions = options as unknown as Record<string, unknown>;
          return broker as never;
        }),
      },
    );

    expect(prepared.taskId).toBe("task:m7-r3:code-only");
    expect(brokerOptions).toBeDefined();
    expect(Object.hasOwn(brokerOptions!, "managedRuntime")).toBe(false);
    expect(
      (brokerOptions!.policy as { readonly readonlyTargets: readonly string[] })
        .readonlyTargets,
    ).toEqual([
      "/bin/bash",
      "/bin/busybox",
      "/usr/bin/find",
      "/usr/bin/ls",
      "/usr/bin/rg",
    ]);
    const mountedTargets = [
      ...(
        brokerOptions!.policy as {
          readonly readonlyTargets: readonly string[];
        }
      ).readonlyTargets,
      ...(
        brokerOptions!.toolchain as {
          readonly capability: {
            readonly files: readonly { readonly target: string }[];
          };
        }
      ).capability.files.map((entry) => entry.target),
    ].join("\n");
    expect(mountedTargets).not.toContain("godot");
    expect(mountedTargets).not.toContain("project-adapter");

    const persistSecurityEvent = brokerOptions!.securityEvents as (
      event: unknown,
    ) => Promise<void>;
    await persistSecurityEvent({
      schemaVersion: 1,
      eventId: "security-event:m7-r3:one",
      taskId: "task:m7-r3:code-only",
      operationId: "operation:m7-r3:one",
      decision: "denied",
      code: "path_denied",
      message: "denied /host/private/SECRET",
      occurredAt: "2026-08-16T00:00:00.000Z",
      target: "/host/private/SECRET",
      sideEffectStarted: false,
    });
    await persistSecurityEvent({
      schemaVersion: 1,
      eventId: "security-event:m7-r3:two",
      taskId: "task:m7-r3:code-only",
      operationId: "operation:m7-r3:two",
      decision: "denied",
      code: "capability_denied",
      message: "denied credential endpoint SECRET_TWO",
      occurredAt: "2026-08-16T00:00:01.000Z",
      target: "https://credentials.invalid/SECRET_TWO",
      sideEffectStarted: false,
    });
    const retainedSecurityEvent = await durableRecords.readOnce(
      "security-event-000001",
    );
    const retainedSecondSecurityEvent = await durableRecords.readOnce(
      "security-event-000002",
    );
    expect(JSON.stringify(retainedSecurityEvent)).not.toContain(
      "/host/private/SECRET",
    );
    expect(retainedSecurityEvent).toMatchObject({
      decision: "denied",
      code: "path_denied",
      sideEffectStarted: false,
    });
    expect(JSON.stringify(retainedSecondSecurityEvent)).not.toContain(
      "SECRET_TWO",
    );
    expect(retainedSecondSecurityEvent).toMatchObject({
      ordinal: 2,
      previousRecordContentSha256: (
        retainedSecurityEvent as { readonly recordContentSha256: string }
      ).recordContentSha256,
      decision: "denied",
      code: "capability_denied",
      sideEffectStarted: false,
    });
  });

  it("retains typed cleanup truth for code-only failures before and after broker acquisition", async () => {
    for (const failurePoint of ["workspace", "agent-resource"] as const) {
      const root = await mkdtemp(
        join(tmpdir(), `chronorift-m7-r3-${failurePoint}-`),
      );
      roots.push(root);
      const layout = await makeLayout(root, "code-only-task");
      const cache = join(root, "agent-cache");
      await mkdir(cache, { mode: 0o700 });
      if (failurePoint === "agent-resource") {
        await mkdir(join(cache, "not-fresh"), { mode: 0o700 });
      }
      const baseline = sha(`baseline:${failurePoint}`);
      const brokerCleanup = vi.fn(async () => ({
        processGroupTerminated: true,
        cgroupPopulated: false,
        termSent: false,
        killSent: false,
        scopeRemoved: true,
        storageReconciled: true,
      }));
      const createBroker = vi.fn(async () => ({
        execute: vi.fn(),
        cleanup: brokerCleanup,
      }));

      await expect(
        prepareM7R3CodeOnlyTaskFromM6RuntimeTaskV1(
          {
            runtimeTask: {
              taskId: "task:m7-r3:runtime",
              assignment: {
                assignment: {
                  mutatedBaselineSelectedTreeSha256: baseline,
                },
                mutatedSource: {
                  repositoryRoot: join(root, "mutant-authority"),
                },
              },
            } as never,
            codeOnlyTaskId: `task:m7-r3:${failurePoint}`,
            agentResourceDirectory: cache,
            durableRecords: { appendSecurityEvent: vi.fn() } as never,
          },
          {
            readHostConfig: vi.fn(
              async () =>
                ({
                  taskStorageRoot: join(root, "task-storage"),
                  runtimeRoot: join(root, "runtime-root"),
                  delegatedCgroupRoot: join(root, "cgroup"),
                  bwrapPath: "/usr/bin/bwrap",
                  prlimitPath: "/usr/bin/prlimit",
                  busyboxPath: "/usr/bin/busybox",
                  lddPath: "/usr/bin/ldd",
                  bashPath: "/host/bin/bash",
                  rgPath: "/host/bin/rg",
                  findPath: "/host/bin/find",
                  lsPath: "/host/bin/ls",
                }) as never,
            ),
            createRuntimeRoot: vi.fn(async () => join(root, "runtime-root")),
            preflightSandbox: vi.fn(
              async () =>
                ({
                  kind: "supported",
                  capability: {
                    runtimeIdentity: sha("sandbox runtime"),
                    taskStorage: {
                      kind: "dedicated-capacity-bounded-filesystem-v1",
                      filesystem: "tmpfs",
                      totalBytes: 1024 * 1024 * 1024,
                      totalInodes: 131_072,
                      rootIdentitySha256: sha("task storage"),
                    },
                  },
                  binding: {
                    taskStorageRoot: join(root, "task-storage"),
                  },
                }) as never,
            ),
            createLayout: vi.fn(async () => layout as never),
            materializeWorkspace: vi.fn(async () => {
              if (failurePoint === "workspace") {
                throw new Error("injected workspace failure");
              }
              return {
                workspaceDirectory: layout.workspaceDirectory,
                hostBaselineGitDirectory: layout.hostBaselineGitDirectory,
                hostBaselineCommit: "0".repeat(40),
                receipt: { selectedTreeSha256: baseline },
              } as never;
            }),
            inspectToolchain: vi.fn(
              async () =>
                ({
                  capability: {
                    toolchainId: `sandbox-toolchain:v1:${sha("toolchain")}`,
                    files: [
                      { target: "/bin/bash" },
                      { target: "/usr/bin/rg" },
                      { target: "/usr/bin/find" },
                      { target: "/usr/bin/ls" },
                    ],
                  },
                }) as never,
            ),
            createBroker: createBroker as never,
          },
        ),
      ).rejects.toMatchObject({
        stage: `m7-r3-code-only:${
          failurePoint === "workspace" ? "workspace" : "agent_resource"
        }`,
        cleanup: {
          sandboxCleanupRequired: failurePoint === "agent-resource",
          cleanupProven: true,
          taskRootRemoved: true,
        },
      });
      expect(createBroker).toHaveBeenCalledTimes(
        failurePoint === "agent-resource" ? 1 : 0,
      );
      expect(brokerCleanup).toHaveBeenCalledTimes(
        failurePoint === "agent-resource" ? 1 : 0,
      );
    }
  });

  it("retains exact baseline and distinct candidate M6 compatibility receipts without synthesizing evidence on read", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-m7-r3-runtime-"));
    roots.push(root);
    const layout = await makeLayout(root, "runtime-task");
    const baseline = sha("mutated baseline selected tree");
    const candidate = sha("candidate selected tree");
    const taskId = "task:m7-r3:runtime";
    const workspaceId = "workspace:m7-r3:runtime";
    const toolchainArtifact = sha("Godot executable");
    const policyProfile = sha("runtime policy");
    let selected = baseline;
    const build = (sourceHash: Sha256DigestV1) => ({
      build: {
        schemaVersion: 1 as const,
        taskId,
        workspaceId,
        sourceId: asSourceId(`source:${sourceHash}`),
        buildId: `build:m7-r3:${sourceHash.slice(0, 24)}`,
        sourceHash,
        workspaceDiffHash: sha(`diff:${sourceHash}`),
        buildConfigurationHash: sha("shared build configuration"),
        outputHash: sha(`output:${sourceHash}`),
        createdAt: "2026-08-16T00:00:00.000Z",
      },
      configuredMainScene: "res://main.tscn",
      projectHash: sha(`project:${sourceHash}`),
      adapterRevision,
      toolchainReceiptId: "toolchain-receipt:m7-r3:test",
      toolchainArtifactDigest: toolchainArtifact,
      runtimeIdentity: {
        schemaVersion: 1 as const,
        managedRuntimeId: "managed-runtime:m7-r3:test",
        engineVersion: "4.7.1",
        runtimeArtifactDigest: toolchainArtifact,
        overlayDigest: sha("runtime overlay"),
      },
      policyProfileDigest: policyProfile,
      fileCount: 3,
      byteLength: 1_024,
    });
    const baselineBuild = build(baseline);
    const candidateBuild = build(candidate);
    const compatibilityReceipts: ReturnType<
      typeof M6AdapterBuildCompatibilityReceiptV1Schema.parse
    >[] = [];
    const createCompatibility = (
      lineage: M6AdapterBuildCompatibilityLineageV1,
    ) =>
      M6AdapterBuildCompatibilityReceiptV1Schema.parse({
        schemaVersion: 1,
        receiptId: `compat:m7-r3:${lineage.buildRole}`,
        lineage,
        bridgeHandshakeObserved: true,
        instrumentedLaunchObserved: true,
        queryObservations: {
          schemaVersion: 1,
          entityQueryObserved: true,
          stateQueryObserved: true,
          entityRows: 1,
          stateRows: 3,
        },
        coverage,
        loss: [],
        cleanup,
        outcome: "compatible",
        failures: [],
        observedAt:
          lineage.buildRole === "assignment_baseline"
            ? "2026-08-16T00:00:01.000Z"
            : "2026-08-16T00:00:02.000Z",
      });
    const persistedRuntimeReceipts: unknown[] = [];
    const taskStore = {
      putPinnedCaptureOnce: vi.fn(),
      putRuntimeObservationReceiptOnce: vi.fn(async (receipt) => {
        persistedRuntimeReceipts.push(receipt);
      }),
    };
    const broker = { execute: vi.fn(), cleanup: vi.fn() };
    const task = {
      taskId,
      workspaceId,
      assignment: {
        assignment: { mutatedBaselineSelectedTreeSha256: baseline },
        adapterRevision,
        adapterPackage: { manifestSha256: adapterRevision.manifestDigest },
      },
      workspace: { workspaceDirectory: layout.workspaceDirectory },
      broker,
      taskStore,
      managedRuntime: {
        capability: {
          engineVersion: "4.7.1",
          managedRuntimeId: "managed-runtime:m7-r3:test",
        },
        sdkDigest: adapterRevision.sdkDigest,
        bridgeDigest: adapterRevision.bridgeDigest,
      },
      toolchain: { executableSha256: toolchainArtifact },
      toolchainReceiptId: "toolchain-receipt:m7-r3:test",
      runtimeIdentity: baselineBuild.runtimeIdentity,
      policyProfileDigest: policyProfile,
      internalAdapterOverlayNamespace:
        "environment-revision:m7-r3:adapter-overlay",
      launchTargetId: "launch:m7-r3:main",
      now: () => "2026-08-16T00:00:00.000Z",
    };
    const written: Array<{ kind: string; payload: JsonValue }> = [];
    const records: M7R3ImmutableRecordWriterV1 = {
      writeOnce: vi.fn(
        async (kind: string, payload: JsonValue, expected?: Sha256DigestV1) => {
          const parsed = JsonValueSchema.parse(payload);
          const actual = shaJson(parsed);
          if (expected !== undefined && expected !== actual) {
            throw new Error("test writer received a crossed expected hash");
          }
          written.push({ kind, payload: parsed });
          return actual;
        },
      ),
      readOnce: vi.fn(async () => {
        throw new Error("test read not configured");
      }),
      readOptional: vi.fn(async () => null),
      appendSecurityEvent: vi.fn(async () => undefined),
    };
    const runtimeOptions: unknown[] = [];
    let agentOptions:
      | {
          readonly resolveCompatibleBuild?: () => Promise<unknown>;
          readonly persistRuntimeObservation?: (
            receipt: unknown,
          ) => Promise<void>;
        }
      | undefined;
    const underlyingAgentClose = vi.fn(async () => undefined);
    const createRuntime = vi.fn((options: unknown) => {
      runtimeOptions.push(options);
      const parsed = options as typeof agentOptions;
      if (parsed?.persistRuntimeObservation !== undefined) {
        agentOptions = parsed;
      }
      const identity = options as {
        readonly taskId: string;
        readonly buildId: string;
        readonly sourceClosureId: string;
        readonly candidateSourceHash: string;
        readonly adapterRevisionId: string;
        readonly adapterPackage: { readonly candidateSha256?: string };
        readonly adapterManifestSha256: string;
        readonly sdkSha256: string;
        readonly bridgeSha256: string;
        readonly toolchainSha256: string;
      };
      return {
        invoke: vi.fn(),
        close:
          parsed?.persistRuntimeObservation === undefined
            ? vi.fn(async () => undefined)
            : underlyingAgentClose,
        adapterBuildCompatibilityIdentity: () => ({
          taskId: identity.taskId,
          buildId: identity.buildId,
          sourceClosureId: identity.sourceClosureId,
          candidateSourceHash: identity.candidateSourceHash,
          adapterRevisionId: identity.adapterRevisionId,
          adapterPackageSha256: adapterRevision.packageDigest,
          adapterManifestSha256: identity.adapterManifestSha256,
          sdkSha256: identity.sdkSha256,
          bridgeSha256: identity.bridgeSha256,
          toolchainSha256: identity.toolchainSha256,
        }),
      } as never;
    });
    const prepareBuild = vi.fn(async () =>
      selected === baseline ? baselineBuild : candidateBuild,
    );
    const runCompatibility = vi.fn(async (input: { lineage: unknown }) => {
      const receipt = createCompatibility(
        input.lineage as M6AdapterBuildCompatibilityLineageV1,
      );
      compatibilityReceipts.push(receipt);
      return { receipt } as never;
    });

    const prepared = await prepareM7R3RuntimeSurfaceFromM6TaskV1({
      task: task as never,
      records,
      pristineAdapterConformanceReceiptSha256: sha(
        "pristine conformance receipt bytes",
      ),
      dependencies: {
        prepareBuild: prepareBuild as never,
        runCompatibility: runCompatibility as never,
        createRuntime,
        createSidecar: vi.fn(() => ({ kind: "fake-sidecar" }) as never),
      },
    });

    expect(prepared.baselineCompatibilityReceipt.lineage.buildRole).toBe(
      "assignment_baseline",
    );
    expect(prepared.surface.adapterMutantCompatibilityReceiptSha256).toBe(
      shaJson(prepared.baselineCompatibilityReceipt),
    );
    expect(agentOptions).toBeDefined();

    const runtimeReceipt = (sourceHash: Sha256DigestV1, ordinal: number) => {
      const selectedBuild =
        sourceHash === baseline ? baselineBuild : candidateBuild;
      return ProjectEnvironmentRuntimeObservationReceiptV1Schema.parse({
        schemaVersion: 1,
        receiptId: `runtime-observation:m7-r3:${ordinal}`,
        taskId,
        runtimeId: `runtime:m7-r3:${ordinal}`,
        executionId: `execution:m7-r3:${ordinal}`,
        buildId: selectedBuild.build.buildId,
        environmentRevisionId: task.internalAdapterOverlayNamespace,
        adapterRevisionId: adapterRevision.adapterRevisionId,
        launchTargetId: task.launchTargetId,
        instrumentationMode: "instrumented",
        status: "stopped",
        bridgeHandshakeCount: 1,
        clock: {
          schemaVersion: 1,
          processFrame: 3,
          physicsTick: 3,
          simulationTimeUs: 50_000,
          renderFrame: null,
          hostMonotonicUs: 100_000,
        },
        queryObservations: {
          schemaVersion: 1,
          entityQueryCount: 1,
          entityRows: 1,
          stateQueryCount: 1,
          stateRows: 3,
        },
        captureCount: 1,
        captureWindowIds: [`capture-window:m7-r3:${ordinal}`],
        coverage,
        loss: [],
        cleanup,
        outcome: "succeeded",
        failures: [],
        startedAt: `2026-08-16T00:00:0${ordinal}.000Z`,
        observedAt: `2026-08-16T00:00:1${ordinal}.000Z`,
        completedAt: `2026-08-16T00:00:2${ordinal}.000Z`,
      });
    };
    await agentOptions!.persistRuntimeObservation!(runtimeReceipt(baseline, 1));
    selected = candidate;
    await agentOptions!.resolveCompatibleBuild!();
    await agentOptions!.persistRuntimeObservation!(
      runtimeReceipt(candidate, 2),
    );

    const beforeRead = {
      builds: prepareBuild.mock.calls.length,
      compatibilities: runCompatibility.mock.calls.length,
      runtimes: createRuntime.mock.calls.length,
    };
    const deliveryHash = sha("exact persisted delivery trace");
    const snapshot = await prepared.surface.readAgentEvidence({
      exchanges: [],
      exchangeTranscriptSha256: shaJson([]),
      deliveryTrace: { recordContentSha256: deliveryHash } as never,
      agentDeliveryTraceRecordSha256: deliveryHash,
      baselineSelectedTreeSha256: baseline,
    });

    expect(snapshot.trajectoryMaterials).toHaveLength(2);
    expect(
      snapshot.trajectoryMaterials.map((entry) => entry.buildRole),
    ).toEqual(["assignment_baseline", "candidate"]);
    expect(
      snapshot.trajectoryMaterials[0]?.adapterBuildCompatibilityReceipt,
    ).toEqual(compatibilityReceipts[0]);
    expect(
      snapshot.trajectoryMaterials[1]?.adapterBuildCompatibilityReceipt,
    ).toEqual(compatibilityReceipts[1]);
    expect(compatibilityReceipts[0]?.receiptId).not.toBe(
      compatibilityReceipts[1]?.receiptId,
    );
    expect({
      builds: prepareBuild.mock.calls.length,
      compatibilities: runCompatibility.mock.calls.length,
      runtimes: createRuntime.mock.calls.length,
    }).toEqual(beforeRead);
    expect(persistedRuntimeReceipts).toHaveLength(2);
    expect(written.map((entry) => entry.kind)).toContain(
      "runtime-backend-projection",
    );

    await prepared.surface.close();
    await prepared.surface.close();
    expect(underlyingAgentClose).toHaveBeenCalledTimes(1);
  });

  it("binds both sentinel surfaces to Host durable roots and retains abort cleanup truth after reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-m7-r3-bound-"));
    roots.push(root);
    const runtimeLayout = await makeLayout(root, "runtime-arm");
    const codeOnlyLayout = await makeLayout(root, "code-only-arm");
    const runtimeCache = join(root, "runtime-cache");
    const codeOnlyCache = join(root, "code-only-cache");
    const runtimeDurableRoot = join(root, "runtime-durable");
    const codeOnlyDurableRoot = join(root, "code-only-durable");
    const protectedBaselineRoot = join(root, "protected-baseline");
    const pristineSourceRoot = join(root, "pristine-source");
    const mutatedSourceRoot = join(root, "mutated-source");
    await Promise.all(
      [
        runtimeCache,
        codeOnlyCache,
        runtimeDurableRoot,
        codeOnlyDurableRoot,
        protectedBaselineRoot,
        pristineSourceRoot,
        mutatedSourceRoot,
      ].map((path) => mkdir(path, { mode: 0o700 })),
    );
    const baseline = sha("bound mutated baseline");
    const runtimeTaskId = "task:m7-r3:bound-runtime";
    const codeOnlyTaskId = "task:m7-r3:bound-code-only";
    const runtimeWorkspaceId = "workspace:m7-r3:bound-runtime";
    const codeOnlyWorkspaceId = "workspace:m7-r3:bound-code-only";
    const goal = "敌人会掉下平台，请修复。";
    const classifierImplementationSha256 = sha(
      "bound generic classifier implementation",
    );
    const publicTask = (taskId: string) =>
      ExternalHiddenFixPublicTaskSpecV1Schema.parse({
        schemaVersion: 1,
        taskKind: "external-hidden-fix",
        taskId,
        subjectCommit: "1".repeat(40),
        goal,
        publicExecutionClassifier: {
          schemaVersion: 1,
          classifierId: "m7-r3-generic-patrol",
          implementationSha256: classifierImplementationSha256,
        },
        agentBudget: {
          provider: "test-provider",
          model: "test-model",
          thinkingLevel: "high",
          attemptsMaximum: 1,
          userTurnsPerAttemptMaximum: 1,
          toolCallsMaximum: 64,
          wallTimeMsMaximum: 900_000,
          taskSandboxNetworkMode: "denied",
          taskCredentialMountCountMaximum: 0,
        },
        evaluatorBudget: {
          scenarioClasses: [
            "public_reproduction",
            "hidden_variant",
            "regression_control",
          ],
          repetitionsPerScenario: 3,
          plannedRunCount: 9,
          evaluatorProcessAttemptsPerRunMaximum: 1,
          freshWorkspacePerRun: true,
          freshImportCachePerRun: true,
          freshEvaluatorProcessPerRun: true,
          agentRelaunchCountMaximum: 0,
          wallTimeMsPerRunMaximum: 60_000,
        },
      });
    const runtimePublicTask = publicTask(runtimeTaskId);
    const codeOnlyPublicTask = publicTask(codeOnlyTaskId);
    const runtimeCleanup = vi.fn(async () => ({
      processGroupTerminated: true,
      cgroupPopulated: false,
      termSent: false,
      killSent: false,
      scopeRemoved: true,
      storageReconciled: true,
    }));
    const codeOnlyCleanup = vi.fn(async () => ({
      processGroupTerminated: true,
      cgroupPopulated: false,
      termSent: false,
      killSent: false,
      scopeRemoved: true,
      storageReconciled: true,
    }));
    const runtimeBroker = {
      execute: vi.fn(),
      cleanup: runtimeCleanup,
    };
    const codeOnlyBroker = {
      execute: vi.fn(),
      cleanup: codeOnlyCleanup,
    };
    const toolchainArtifact = sha("bound Godot executable");
    const policyProfile = sha("bound shared coding sandbox policy");
    const preparedBuild = {
      build: {
        schemaVersion: 1 as const,
        taskId: runtimeTaskId,
        workspaceId: runtimeWorkspaceId,
        sourceId: asSourceId(`source:${baseline}`),
        buildId: `build:m7-r3:${baseline.slice(0, 24)}`,
        sourceHash: baseline,
        workspaceDiffHash: sha("bound workspace diff"),
        buildConfigurationHash: sha("bound build configuration"),
        outputHash: sha("bound build output"),
        createdAt: "2026-08-16T00:00:00.000Z",
      },
      configuredMainScene: "res://main.tscn",
      projectHash: sha("bound project"),
      adapterRevision,
      toolchainReceiptId: "toolchain-receipt:m7-r3:bound",
      toolchainArtifactDigest: toolchainArtifact,
      runtimeIdentity: {
        schemaVersion: 1 as const,
        managedRuntimeId: "managed-runtime:m7-r3:bound",
        engineVersion: "4.7.1",
        runtimeArtifactDigest: toolchainArtifact,
        overlayDigest: sha("bound runtime overlay"),
      },
      policyProfileDigest: policyProfile,
      fileCount: 3,
      byteLength: 1_024,
    };
    const runtimeClose = vi.fn(async () => undefined);
    const compatibilityFor = (lineage: M6AdapterBuildCompatibilityLineageV1) =>
      M6AdapterBuildCompatibilityReceiptV1Schema.parse({
        schemaVersion: 1,
        receiptId: "compat:m7-r3:bound-baseline",
        lineage,
        bridgeHandshakeObserved: true,
        instrumentedLaunchObserved: true,
        queryObservations: {
          schemaVersion: 1,
          entityQueryObserved: true,
          stateQueryObserved: true,
          entityRows: 1,
          stateRows: 3,
        },
        coverage,
        loss: [],
        cleanup,
        outcome: "compatible",
        failures: [],
        observedAt: "2026-08-16T00:00:01.000Z",
      });
    let hostNow = "2026-08-16T00:00:02.000Z";
    const runtimeTask = {
      taskId: runtimeTaskId,
      workspaceId: runtimeWorkspaceId,
      publicTask: runtimePublicTask,
      agentDir: runtimeCache,
      assignment: {
        assignment: { mutatedBaselineSelectedTreeSha256: baseline },
        adapterRevision,
        adapterPackage: { manifestSha256: adapterRevision.manifestDigest },
        protectedBaselineRoot,
        pristineSource: { repositoryRoot: pristineSourceRoot },
        mutatedSource: { repositoryRoot: mutatedSourceRoot },
        agentProjection: {
          publicTask: { sha256: shaJson(runtimePublicTask) },
          adapter: {
            conformanceReceiptSha256: sha("bound pristine Adapter conformance"),
          },
        },
      },
      layout: runtimeLayout,
      workspace: {
        workspaceDirectory: runtimeLayout.workspaceDirectory,
        hostBaselineGitDirectory: runtimeLayout.hostBaselineGitDirectory,
        hostBaselineCommit: "2".repeat(40),
        receipt: {
          schemaVersion: 1,
          selectedTreeSha256: baseline,
          fixture: "runtime",
        },
      },
      broker: runtimeBroker,
      taskStore: {
        putPinnedCaptureOnce: vi.fn(),
        putRuntimeObservationReceiptOnce: vi.fn(),
      },
      managedRuntime: {
        capability: {
          engineVersion: "4.7.1",
          managedRuntimeId: "managed-runtime:m7-r3:bound",
          toolchain: {
            files: [{ target: "/opt/chronorift/godot" }],
          },
          fontconfigTarget: "/opt/chronorift/fontconfig",
          addonParentTarget: "/opt/chronorift/addons",
          addonTarget: "/opt/chronorift/addons/chronorift",
          overlayTarget: "/opt/chronorift/overlay",
          adapterParentTarget: "/opt/chronorift/adapters",
          adapterTarget: "/opt/chronorift/adapters/generic-patrol",
        },
        sdkDigest: adapterRevision.sdkDigest,
        bridgeDigest: adapterRevision.bridgeDigest,
      },
      toolchain: { executableSha256: toolchainArtifact },
      toolchainReceiptId: "toolchain-receipt:m7-r3:bound",
      runtimeIdentity: preparedBuild.runtimeIdentity,
      policyProfileDigest: policyProfile,
      codingSandboxProfileSha256: policyProfile,
      sandboxRealization: {
        schemaVersion: 1,
        runtimeIdentity: sha("bound runtime sandbox"),
      },
      internalAdapterOverlayNamespace:
        "environment-revision:m7-r3:bound-adapter-overlay",
      launchTargetId: "launch:m7-r3:bound-main",
      hostAdmittedGameToolNames: ["game_query"],
      patchStore: { publishOnce: vi.fn() },
      assertTaskStorageHeadroom: vi.fn(async () => taskStorageHeadroom),
      now: () => hostNow,
    };
    const codeOnlyWorkspace = {
      workspaceDirectory: codeOnlyLayout.workspaceDirectory,
      hostBaselineGitDirectory: codeOnlyLayout.hostBaselineGitDirectory,
      hostBaselineCommit: "3".repeat(40),
      receipt: {
        schemaVersion: 1,
        selectedTreeSha256: baseline,
        fixture: "code-only",
      },
    };
    const trajectoryCaseSpec = createM7R3PatrolTrajectoryCaseSpecV1({
      classifierImplementationSha256,
      expectedBaselineWitnessKinds: ["ground_contact_loss"],
      expectedRecoveryWitnessKinds: ["direction_recovery"],
      frozenAt: "2026-08-16T00:00:00.000Z",
    });
    const codeOnlyPatchStore = { publishOnce: vi.fn() };
    const additionalForbiddenPaths = [
      join(root, "host-only-materials"),
      join(root, "host-only-materials", "mutation.patch"),
      join(root, "host-only-materials", "evaluator.mjs"),
      join(root, "host-only-materials", "evaluator-bundle.json"),
    ];
    const infrastructure = await prepareM7R3ProjectEnvironmentInfrastructureV1(
      {
        runtimeTask: runtimeTask as never,
        codeOnlyPublicTask,
        codeOnlyPublicTaskSpecSha256: shaJson(codeOnlyPublicTask),
        codeOnlyPatchStore: codeOnlyPatchStore as never,
        runtimeAgentResourceDirectory: runtimeCache,
        codeOnlyAgentResourceDirectory: codeOnlyCache,
        runtimeDurableRecordRoot: runtimeDurableRoot,
        codeOnlyDurableRecordRoot: codeOnlyDurableRoot,
        trajectoryClassifierConfig: M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1,
        trajectoryCaseSpec,
        hostModelRuntimeConfigSha256: sha("bound Host model config"),
        additionalCodingSandboxSentinelForbiddenPaths: additionalForbiddenPaths,
      },
      {
        prepareCodeOnlyTask: vi.fn(
          async (
            input: Parameters<
              typeof prepareM7R3CodeOnlyTaskFromM6RuntimeTaskV1
            >[0],
          ) => ({
            taskId: codeOnlyTaskId,
            workspaceId: codeOnlyWorkspaceId,
            layout: codeOnlyLayout,
            workspace: codeOnlyWorkspace,
            broker: codeOnlyBroker,
            policyProfileSha256: policyProfile,
            sandboxInstanceSha256: sha("bound code-only sandbox"),
            codingToolchainTargets: [
              "/bin/bash",
              "/usr/bin/rg",
              "/usr/bin/find",
              "/usr/bin/ls",
            ],
            agentResourceDirectory: codeOnlyCache,
            records: input.durableRecords,
            assertTaskStorageHeadroom: vi.fn(async () => taskStorageHeadroom),
          }),
        ) as never,
        prepareBuild: vi.fn(async () => preparedBuild) as never,
        runCompatibility: vi.fn(
          async (input: {
            readonly lineage: M6AdapterBuildCompatibilityLineageV1;
          }) => ({
            receipt: compatibilityFor(input.lineage),
          }),
        ) as never,
        createRuntime: vi.fn(
          () =>
            ({
              invoke: vi.fn(),
              close: runtimeClose,
              adapterBuildCompatibilityIdentity: vi.fn(),
            }) as never,
        ),
        createSidecar: vi.fn(() => ({ kind: "fake-sidecar" }) as never),
      },
    );
    const registration = infrastructure.registrationInputs;
    const naturalPrompt = createM7R3NaturalUserPromptV1(goal);
    const agentBudget = {
      schemaVersion: 1 as const,
      attemptsMaximum: 1 as const,
      userTurnsPerAttemptMaximum: 1 as const,
      toolCallsMaximum: 64,
      wallTimeMsMaximum: 900_000,
      taskSandboxNetworkMode: "denied" as const,
      taskCredentialMountCountMaximum: 0 as const,
    };
    const commonRuntimeMaterials = {
      authoritativeSensorFreezeRecordSha256: sha("bound sensor freeze"),
      adapterRevisionSha256: shaJson(adapterRevision),
      adapterPackageSha256: adapterRevision.packageDigest,
      adapterObservationSchemaSha256: adapterRevision.payloadSchemaDigest,
      trajectoryClassifierFreezeRecordSha256: sha("bound classifier freeze"),
      trajectoryClassifierImplementationSha256: classifierImplementationSha256,
      trajectoryClassifierConfigSha256:
        M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1.configSha256,
      validatedGameToolSetSha256: registration.validatedGameToolSetSha256,
      pristineAdapterConformanceReceiptSha256:
        registration.pristineAdapterConformanceReceiptSha256,
      commonEnvironmentInstructionsSha256:
        M7_R3_NEUTRAL_ENVIRONMENT_INSTRUCTIONS_SHA256_V1,
      hostModelRuntimeConfigSha256: registration.hostModelRuntimeConfigSha256,
    };
    const agentConfiguration = {
      provider: "test-provider",
      model: "test-model",
      thinkingLevel: "high" as const,
      agentBudgetSha256: shaJson(agentBudget),
      codingToolSetSha256: registration.codingToolSetSha256,
      sandboxPolicySha256: policyProfile,
    };
    const secondPrompt =
      createM7R3NaturalUserPromptV1("敌人在斜坡上移动不稳定，请修复。");
    const secondTrajectoryCaseSpec = createM7R3PatrolTrajectoryCaseSpecV1({
      classifierImplementationSha256,
      expectedBaselineWitnessKinds: ["grounded_stall"],
      expectedRecoveryWitnessKinds: ["sustained_grounded_motion"],
      frozenAt: "2026-08-16T00:00:00.000Z",
    });
    const secondMutant = sha("bound second mutant");
    const pairedPublicTaskContractSha256 = sha(
      "bound paired public Task contract",
    );
    const portfolio = createM7R3TwoCasePortfolioFreezeV1({
      commonRuntimeMaterials,
      agentConfiguration,
      pairedAttemptPlan: {
        armOrder: ["runtime_enabled", "code_only"],
        attemptsPerArm: 1,
        retriesAllowed: false,
        userTurnsPerArm: 1,
      },
      evaluationPlan: {
        scenarioClassOrder: [
          "public_reproduction",
          "hidden_variant",
          "regression_control",
        ],
        repetitionsPerScenarioClass: 3,
        expectedFreshCopyRunCount: 9,
        freshCopyPerRun: true,
      },
      cases: [
        {
          subject: {
            subjectProjectSha256: sha("bound external project"),
            pristineProjectRevision: "4".repeat(40),
            pristineSelectedTreeSha256: sha("bound pristine tree"),
          },
          mutant: {
            mutationSha256: sha("bound mutation one"),
            mutatedBuildSourceId: preparedBuild.build.sourceId,
            mutatedBuildSourceSha256: baseline,
            mutatedBaselineSelectedTreeSha256: baseline,
            mutatedBuildSourceIdentitySha256:
              deriveM7BuildSourceIdentitySha256V1({
                sourceId: preparedBuild.build.sourceId,
                sourceHash: baseline,
              }),
          },
          naturalPromptUtf8Sha256: naturalPrompt.utf8Sha256,
          trajectoryCaseSpecId: trajectoryCaseSpec.caseId,
          trajectoryCaseSpecSha256: trajectoryCaseSpec.caseSpecSha256,
          adapterMutantCompatibilityReceiptSha256:
            registration.adapterMutantCompatibilityReceiptSha256,
          pairedPublicTaskContractSha256,
          preflightImplementationSha256: sha("bound preflight one"),
          evaluatorImplementationSha256: sha("bound evaluator one"),
          evaluatorBundleSha256: sha("bound evaluator bundle one"),
        },
        {
          subject: {
            subjectProjectSha256: sha("bound external project"),
            pristineProjectRevision: "4".repeat(40),
            pristineSelectedTreeSha256: sha("bound pristine tree"),
          },
          mutant: {
            mutationSha256: sha("bound mutation two"),
            mutatedBuildSourceId: asSourceId(`source:${secondMutant}`),
            mutatedBuildSourceSha256: secondMutant,
            mutatedBaselineSelectedTreeSha256: secondMutant,
            mutatedBuildSourceIdentitySha256:
              deriveM7BuildSourceIdentitySha256V1({
                sourceId: asSourceId(`source:${secondMutant}`),
                sourceHash: secondMutant,
              }),
          },
          naturalPromptUtf8Sha256: secondPrompt.utf8Sha256,
          trajectoryCaseSpecId: secondTrajectoryCaseSpec.caseId,
          trajectoryCaseSpecSha256: secondTrajectoryCaseSpec.caseSpecSha256,
          adapterMutantCompatibilityReceiptSha256: sha(
            "bound second compatibility",
          ),
          pairedPublicTaskContractSha256: sha(
            "bound second paired public Task contract",
          ),
          preflightImplementationSha256: sha("bound preflight two"),
          evaluatorImplementationSha256: sha("bound evaluator two"),
          evaluatorBundleSha256: sha("bound evaluator bundle two"),
        },
      ],
      frozenAt: "2026-08-16T00:00:00.000Z",
    });
    const firstCase = portfolio.cases[0]!;
    const contract = createM7R3PairedCaseContractV1({
      portfolioId: portfolio.portfolioId,
      caseOrdinal: 1,
      caseId: firstCase.caseId,
      mutatedBaselineSelectedTreeSha256: baseline,
      naturalPrompt,
      pairedAgentProtocolImplementationSha256: sha(
        "bound paired Agent protocol",
      ),
      pairedPublicTaskContractSha256,
      runtimeArmPublicTaskSpecSha256:
        registration.runtimeArmPublicTaskSpecSha256,
      codeOnlyArmPublicTaskSpecSha256:
        registration.codeOnlyArmPublicTaskSpecSha256,
      adapterMutantCompatibilityReceiptSha256:
        registration.adapterMutantCompatibilityReceiptSha256,
      commonRuntimeMaterials,
      agentConfiguration,
      trajectoryClassifierConfig: M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1,
      trajectoryCaseSpec,
    });
    const admission = createM7R3CaseCampaignAdmissionV1({
      portfolioFreeze: portfolio,
      caseOrdinal: 1,
      campaignId: "m7-campaign:555555555555555555555555",
      mutationRegistrationRecordSha256: sha("bound mutation registration"),
      naturalPromptCanonicalJsonSha256: naturalPrompt.canonicalJsonSha256,
      pairedAgentProtocolImplementationSha256:
        contract.pairedAgentProtocolImplementationSha256,
      pairedCaseContractContentSha256: contract.pairedCaseContractContentSha256,
      runtimeArmPublicTaskSpecSha256: contract.runtimeArmPublicTaskSpecSha256,
      codeOnlyArmPublicTaskSpecSha256: contract.codeOnlyArmPublicTaskSpecSha256,
      admittedAt: "2026-08-16T00:00:03.000Z",
    });
    const bound = await infrastructure.bindCaseOnce({
      caseContract: contract,
      caseCampaignAdmission: admission,
    });

    expect(bound.hasAgentStarted()).toBe(false);
    const boundProtocol = createM7R3PairedAgentProtocolV1(bound.pairedInput);
    const runtimeRequest = boundProtocol.runtimeRequest;
    const observedTaskStorage =
      await bound.runtimeArm.assertTaskStorageHeadroom();
    const headroomReceiptInput = {
      campaignId: runtimeRequest.campaignId,
      portfolioId: runtimeRequest.portfolioId,
      caseId: runtimeRequest.caseId,
      pairedCaseContractContentSha256:
        runtimeRequest.pairedCaseContractContentSha256,
      arm: "runtime_enabled" as const,
      taskId: runtimeRequest.isolation.taskId,
      attemptBindingContentSha256:
        runtimeRequest.attemptBinding.bindingContentSha256,
      availableBytes: observedTaskStorage.availableBytes,
      availableInodes: observedTaskStorage.availableInodes,
      requiredAvailableBytes: observedTaskStorage.requiredAvailableBytes,
      requiredAvailableInodes: observedTaskStorage.requiredAvailableInodes,
      observedAt: hostNow,
    };
    await expect(
      bound.runtimeArm.persistTaskStorageHeadroomReceiptOnce(
        createM7R3TaskStorageHeadroomReceiptV1({
          ...headroomReceiptInput,
          caseId: "m7-case:wrong-binding",
        }),
      ),
    ).rejects.toThrow(/exact case\/attempt binding/u);
    const headroomReceipt =
      createM7R3TaskStorageHeadroomReceiptV1(headroomReceiptInput);
    await expect(
      bound.runtimeArm.persistTaskStorageHeadroomReceiptOnce(headroomReceipt),
    ).resolves.toBe(headroomReceipt.recordContentSha256);
    await bound.runtimeArm.persistEvaluatorHeadroomObservation({
      runOrdinal: 1,
      taskStorage: taskStorageHeadroom,
      evaluatorStorage: taskStorageHeadroom,
      observedAt: "2026-08-16T00:00:01.000Z",
    });
    await bound.runtimeArm.persistEvaluatorHeadroomObservation({
      runOrdinal: 2,
      taskStorage: taskStorageHeadroom,
      evaluatorStorage: taskStorageHeadroom,
      observedAt: "2026-08-16T00:00:02.000Z",
    });
    hostNow = "2026-08-16T00:10:00.000Z";
    const runtimeAdmission = M7R3LocalArmAdmissionV1Schema.parse(
      await bound.armPort.getArmAdmission("runtime_enabled"),
    );
    expect(runtimeAdmission.claim.binding.publicTaskSpecSha256).toBe(
      contract.pairedPublicTaskContractSha256,
    );
    expect(runtimeAdmission.pairedAttemptBinding.publicTaskSpecSha256).toBe(
      contract.runtimeArmPublicTaskSpecSha256,
    );
    bound.runtimeArm.markAgentStartedOnce();
    await bound.runtimeArm.runtime.close();
    const realizedRuntimeCleanup = await runtimeBroker.cleanup();
    await Promise.resolve();
    const runtimeCleanupBarrierAt = "2026-08-16T00:20:00.000Z";
    hostNow = runtimeCleanupBarrierAt;
    await bound.runtimeArm.persistCleanupReceiptOnce(
      JsonValueSchema.parse({
        schemaVersion: 1,
        recordKind: "m7-r3-paired-arm-cleanup",
        arm: "runtime_enabled",
        sandboxCleanup: realizedRuntimeCleanup,
        proven: true,
        failures: [],
        completedAt: hostNow,
      }),
    );
    hostNow = "2026-08-16T00:30:00.000Z";
    const codeOnlyAdmission = M7R3LocalArmAdmissionV1Schema.parse(
      await bound.armPort.getArmAdmission("code_only"),
    );
    expect(codeOnlyAdmission.claim.binding.publicTaskSpecSha256).toBe(
      contract.pairedPublicTaskContractSha256,
    );
    expect(codeOnlyAdmission.pairedAttemptBinding.publicTaskSpecSha256).toBe(
      contract.codeOnlyArmPublicTaskSpecSha256,
    );
    expect(Date.parse(runtimeAdmission.claim.startedAt)).toBeLessThan(
      Date.parse(runtimeCleanupBarrierAt),
    );
    expect(Date.parse(codeOnlyAdmission.claim.startedAt)).toBeGreaterThan(
      Date.parse(runtimeCleanupBarrierAt),
    );
    const realizedCodeOnlyCleanup = await codeOnlyBroker.cleanup();
    await bound.codeOnlyArm.persistCleanupReceiptOnce(
      JsonValueSchema.parse({
        schemaVersion: 1,
        recordKind: "m7-r3-paired-arm-cleanup",
        arm: "code_only",
        sandboxCleanup: realizedCodeOnlyCleanup,
        proven: true,
        failures: [],
        completedAt: hostNow,
      }),
    );
    expect(bound.hasAgentStarted()).toBe(true);
    await expect(bound.armPort.getArmAdmission("code_only")).rejects.toThrow(
      /only once/u,
    );
    expect(Object.hasOwn(bound.codeOnlyArm, "runtime")).toBe(false);
    for (const arm of [bound.runtimeArm, bound.codeOnlyArm]) {
      expect(arm.codingSandboxSentinelForbiddenPaths).toEqual(
        expect.arrayContaining([
          runtimeDurableRoot,
          codeOnlyDurableRoot,
          ...additionalForbiddenPaths,
        ]),
      );
    }
    const infrastructureFailureSha =
      await bound.persistInfrastructureFailureOnce({
        stage: "case_binding",
        errorClassSha256: sha("TypeError"),
        observedAt: "2026-08-16T00:00:04.000Z",
      });
    await expect(
      bound.persistInfrastructureFailureOnce({
        stage: "cleanup",
        errorClassSha256: sha("Error"),
        observedAt: "2026-08-16T00:00:05.000Z",
      }),
    ).rejects.toThrow(/already retained/u);
    const cleanupTruth = await bound.cleanupRemainingAfterFailure();

    expect(cleanupTruth).toMatchObject({
      cleanupProven: true,
      sandboxSafetyFailure: false,
      sandboxSafetyReceiptSha256: null,
    });
    expect(cleanupTruth.cleanupReceiptSha256).not.toBeNull();
    expect(runtimeCleanup).toHaveBeenCalledTimes(1);
    expect(codeOnlyCleanup).toHaveBeenCalledTimes(1);
    expect(runtimeClose).toHaveBeenCalledTimes(1);
    const reopenedRuntime = await reopenM7R3DurableRecordStoreV1({
      root: runtimeDurableRoot,
      taskId: runtimeTaskId,
    });
    const reopenedCodeOnly = await reopenM7R3DurableRecordStoreV1({
      root: codeOnlyDurableRoot,
      taskId: codeOnlyTaskId,
    });
    expect(
      M7R3TaskStorageHeadroomReceiptV1Schema.parse(
        await reopenedRuntime.readOnce("task-storage-headroom"),
      ),
    ).toEqual(headroomReceipt);
    expect(
      M7R3EvaluatorHeadroomReceiptV1Schema.parse(
        await reopenedRuntime.readOnce("evaluator-headroom-000001"),
      ),
    ).toMatchObject({
      campaignId: admission.campaignId,
      portfolioId: contract.portfolioId,
      caseId: contract.caseId,
      pairedCaseContractContentSha256: contract.pairedCaseContractContentSha256,
      arm: "runtime_enabled",
      taskId: runtimeTaskId,
      attemptBindingContentSha256:
        runtimeRequest.attemptBinding.bindingContentSha256,
      boundary: "evaluator_pre_run",
      runOrdinal: 1,
    });
    expect(
      M7R3EvaluatorHeadroomReceiptV1Schema.parse(
        await reopenedRuntime.readOnce("evaluator-headroom-000002"),
      ),
    ).toMatchObject({ runOrdinal: 2 });
    expect(
      await reopenedRuntime.readOnce("infrastructure-failure"),
    ).toMatchObject({
      recordContentSha256: infrastructureFailureSha,
      stage: "case_binding",
      errorClassSha256: sha("TypeError"),
    });
    expect(
      JSON.stringify(await reopenedRuntime.readOnce("infrastructure-failure")),
    ).not.toMatch(/message|path/iu);
    expect(
      await reopenedRuntime.readOnce("preparation-cleanup-summary"),
    ).toMatchObject({
      recordContentSha256: cleanupTruth.cleanupReceiptSha256,
      cleanupProven: true,
    });
    expect(await reopenedRuntime.readOnce("cleanup")).toMatchObject({
      arm: "runtime_enabled",
      proven: true,
      completedAt: runtimeCleanupBarrierAt,
    });
    expect(await reopenedCodeOnly.readOnce("cleanup")).toMatchObject({
      arm: "code_only",
      proven: true,
    });
    expect(
      await bound.retainedEvidence.readSandboxSentinelReceipt(
        "runtime_enabled",
      ),
    ).toBeNull();
    expect(
      await bound.retainedEvidence.readSandboxSentinelReceipt("code_only"),
    ).toBeNull();
  });
});
