import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1 } from "@chronorift/agent-protocol";
import {
  M6AdapterBuildCompatibilityReceiptV1Schema,
  PROJECT_CAPABILITY_MODULE_NAMES_V1,
  ProjectAdapterRevisionV1Schema,
  asSha256DigestV1,
  asTaskId,
  asWorkspaceId,
  type M6AdapterBuildCompatibilityLineageV1,
} from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";
import type { RunVNextPiSdkTurnOptions } from "@chronorift/pi-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

import { collectCandidateGodotSourceV1 } from "./candidate-godot-build.js";
import type { PreparedExternalHiddenFixAssignmentV1 } from "./external-hidden-fix-assignment.js";
import {
  M6TaskStorageHeadroomReceiptV1Schema,
  createM6AgentAttemptBindingFromPreparedTaskV1,
  createM6OneTurnRequestFromPreparedTaskV1,
  createM6ProjectEnvironmentOneTurnAgentPortV1,
  type PreparedM6ProjectEnvironmentOneTurnTaskV1,
} from "./m6-project-environment-one-turn.js";
import { runM6OneTurnAgentV1 } from "./m6-one-turn-agent.js";
import { selectedTreeSha256 } from "./selected-tree.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

const digest = (value: string) =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));

const adapterRevision = ProjectAdapterRevisionV1Schema.parse({
  schemaVersion: 1,
  adapterRevisionId: "adapter-revision:m6:pristine",
  adapterId: "adapter:m6:task-blind",
  sourceId: `source:v1:${digest("pristine")}`,
  packageDigest: digest("adapter-package"),
  manifestDigest: digest("adapter-manifest"),
  implementationDigest: digest("adapter-implementation"),
  payloadSchemaDigest: digest("adapter-schemas"),
  sdkDigest: digest("sdk"),
  bridgeDigest: digest("bridge"),
  capabilitySet: {
    schemaVersion: 1,
    modules: PROJECT_CAPABILITY_MODULE_NAMES_V1.map((module) => ({
      schemaVersion: 1,
      module,
      status: "implemented",
      protocolVersion: "project-environment-v1",
      limitations: [],
    })),
  },
  conformanceReceiptId: "conformance:m6:pristine",
  contentByteLength: 100,
  contentFileCount: 2,
});

const publicTask = {
  schemaVersion: 1 as const,
  taskKind: "external-hidden-fix" as const,
  taskId: "task:m6-one-turn-production-test",
  subjectCommit: "1".repeat(40),
  goal: "Investigate the public runtime symptom, edit the source, and rerun it.",
  publicExecutionClassifier: {
    schemaVersion: 1 as const,
    classifierId: "moddable-platformer-public-symptom-v1",
    implementationSha256: digest("public classifier v1"),
  },
  agentBudget: {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    thinkingLevel: "max" as const,
    attemptsMaximum: 1 as const,
    userTurnsPerAttemptMaximum: 1 as const,
    toolCallsMaximum: 64,
    wallTimeMsMaximum: 900_000,
    taskSandboxNetworkMode: "denied" as const,
    taskCredentialMountCountMaximum: 0 as const,
  },
  evaluatorBudget: {
    scenarioClasses: [
      "public_reproduction",
      "hidden_variant",
      "regression_control",
    ] as const,
    repetitionsPerScenario: 3 as const,
    plannedRunCount: 9 as const,
    evaluatorProcessAttemptsPerRunMaximum: 1 as const,
    freshWorkspacePerRun: true as const,
    freshImportCachePerRun: true as const,
    freshEvaluatorProcessPerRun: true as const,
    agentRelaunchCountMaximum: 0 as const,
    wallTimeMsPerRunMaximum: 120_000,
  },
};

const completeCleanup = {
  schemaVersion: 1 as const,
  processTreeTerminated: true,
  runtimeExited: true,
  bridgeExited: true,
  isolationGroupEmpty: true,
  scopeRemoved: true,
  scratchRemoved: true,
  storageReconciled: true,
};

const compatibilityReceipt = (lineage: M6AdapterBuildCompatibilityLineageV1) =>
  M6AdapterBuildCompatibilityReceiptV1Schema.parse({
    schemaVersion: 1,
    receiptId: `m6-compatibility:${lineage.buildRole}:${lineage.build.buildId.slice(-8)}`,
    lineage,
    bridgeHandshakeObserved: true,
    instrumentedLaunchObserved: true,
    queryObservations: {
      schemaVersion: 1,
      entityQueryObserved: true,
      stateQueryObserved: true,
      entityRows: 1,
      stateRows: 1,
    },
    coverage: [
      {
        schemaVersion: 1,
        channelId: "project_adapter_observations",
        status: "complete",
        observedRecords: 2,
        droppedRecords: 0,
        overwrittenRecords: 0,
        limitations: [],
      },
    ],
    loss: [],
    cleanup: completeCleanup,
    outcome: "compatible",
    failures: [],
    observedAt: "2026-08-14T00:00:01.000Z",
  });

const compatibleResult = (lineage: M6AdapterBuildCompatibilityLineageV1) => {
  const receipt = compatibilityReceipt(lineage);
  return {
    pendingBinding: {
      schemaVersion: 1,
      bindingId: "m6-binding:pending",
      lineage,
      compatibilityStatus: "pending",
      compatibilityReceiptId: null,
      createdAt: "2026-08-14T00:00:00.000Z",
      completedAt: null,
    },
    receipt,
    binding: {
      schemaVersion: 1,
      bindingId: "m6-binding:complete",
      lineage,
      compatibilityStatus: "compatible",
      compatibilityReceiptId: receipt.receiptId,
      createdAt: "2026-08-14T00:00:00.000Z",
      completedAt: "2026-08-14T00:00:01.000Z",
    },
  } as const;
};

const createTask =
  async (): Promise<PreparedM6ProjectEnvironmentOneTurnTaskV1> => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-m6-production-"));
    temporaryRoots.push(root);
    const workspaceDirectory = join(root, "workspace");
    await mkdir(join(workspaceDirectory, "scripts"), { recursive: true });
    await Promise.all([
      writeFile(
        join(workspaceDirectory, "project.godot"),
        '[application]\nrun/main_scene="res://main.tscn"\n',
      ),
      writeFile(
        join(workspaceDirectory, "main.tscn"),
        '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n',
      ),
      writeFile(
        join(workspaceDirectory, "scripts", "player.gd"),
        "extends Node\nvar speed := 10\n",
      ),
    ]);
    const entries = await collectCandidateGodotSourceV1(
      workspaceDirectory,
      "project-environment",
      "tracked-tool-scripts-v1",
    );
    const baseline = selectedTreeSha256(entries);
    const assignmentId = "m6-assignment:0123456789abcdef01234567";
    const assignment = {
      assignment: {
        assignmentId,
        mutatedBaselineSelectedTreeSha256: baseline,
        taskBlindAdapterSha256: digest("task-blind-adapter"),
      },
      agentProjection: {
        assignmentId,
        baselineSelectedTreeSha256: baseline,
        projectionContentSha256: digest("projection"),
        publicTask: { sha256: digest("public-task"), spec: publicTask },
      },
      adapterRevision,
      adapterPackage: {
        candidateSha256: adapterRevision.packageDigest,
        manifestSha256: adapterRevision.manifestDigest,
        manifest: {
          launchTargets: [{ targetId: "main", default: true }],
        },
      },
    } as unknown as PreparedExternalHiddenFixAssignmentV1;
    const sandboxCleanup = vi.fn(async () => ({
      processGroupTerminated: true,
      cgroupPopulated: false,
      termSent: false,
      killSent: false,
      scopeRemoved: true,
      storageReconciled: true,
    }));
    const recordWrite = vi.fn(async (_kind: string, payload: unknown) =>
      digest(contentHash(payload as never)),
    );
    return {
      schemaVersion: 1,
      assignment,
      publicTask,
      taskId: asTaskId(publicTask.taskId),
      workspaceId: asWorkspaceId(`workspace.v1.${publicTask.taskId}`),
      layout: {
        taskRootDirectory: root,
        taskRecordDirectory: join(root, "records"),
        runtimeRecordDirectory: join(root, "runtime-records"),
        workspaceDirectory,
        sandboxTemporaryDirectory: join(root, "tmp"),
        sandboxArtifactScratchDirectory: join(root, "artifacts"),
        piSessionDirectory: join(root, "pi"),
        hostBaselineGitDirectory: join(root, "baseline.git"),
        hostOperationTemporaryDirectory: join(root, "host-tmp"),
        projectEnvironmentRecordDirectory: join(root, "pe-records"),
      },
      workspace: {
        sourceKind: "project-environment-v1-clean-git",
        workspaceDirectory,
        hostBaselineGitDirectory: join(root, "baseline.git"),
        agentBaselineCommit: "2".repeat(40),
        hostBaselineCommit: "3".repeat(40),
        receipt: {
          schemaVersion: 1,
          receiptKind: "project-environment-workspace-materialization",
          taskId: asTaskId(publicTask.taskId),
          projectSourceIdentity: digest("mutant-project"),
          sourceRevision: "1".repeat(40),
          selectedTreeSha256: baseline,
          agentBaselineCommit: "2".repeat(40),
          hostBaselineCommit: "3".repeat(40),
          copyRule: "git-object-plumbing-v1",
          excludedPaths: [".git", ".godot", ".chronorift"],
          sourcePostflight: {
            observedHeadCommit: "1".repeat(40),
            observedSelectedTreeSha256: baseline,
            statusPorcelainSha256: digest("clean"),
            stagingWorktreeRegistered: false,
          },
        },
        projectSourceIdentity: digest("mutant-project"),
        mainScene: "res://main.tscn",
      },
      broker: { cleanup: sandboxCleanup } as never,
      taskStore: {
        putToolchainReceiptOnce: vi.fn(),
        putPinnedCaptureOnce: vi.fn(),
        putRuntimeObservationReceiptOnce: vi.fn(),
      },
      patchStore: { publishOnce: vi.fn() },
      records: { write: recordWrite },
      managedRuntime: {
        capability: {
          managedRuntimeId: "managed-runtime:m6",
          engineVersion: "4.7.1-stable (official)",
          overlayHash: digest("overlay"),
        },
        sdkDigest: adapterRevision.sdkDigest,
        bridgeDigest: adapterRevision.bridgeDigest,
      } as never,
      toolchain: {
        executableSha256: digest("godot"),
      } as never,
      toolchainReceiptId: "toolchain:m6:godot-4.7.1",
      policyProfileDigest: digest("policy"),
      runtimeIdentity: {
        schemaVersion: 1,
        managedRuntimeId: "managed-runtime:m6",
        engineVersion: "4.7.1-stable (official)",
        runtimeArtifactDigest: digest("runtime"),
        overlayDigest: digest("overlay"),
      },
      internalAdapterOverlayNamespace: "m6-adapter-overlay:v1:test",
      launchTargetId: "main",
      hostAdmittedGameToolNames: [
        PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.capabilities,
        PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.query,
      ],
      publicExecutionClassifier: {
        identity: publicTask.publicExecutionClassifier,
        classify: vi.fn(async () => ({
          publicSymptomObserved: false,
          observation: { schemaVersion: 1 },
        })),
      },
      sandboxRealization: {
        schemaVersion: 1,
        policyProfileDigest: digest("policy"),
        runtimeArtifactDigest: digest("runtime"),
        toolchainArtifactDigest: digest("godot"),
        workspaceBaselineSelectedTreeSha256: baseline,
      },
      assertTaskStorageHeadroom: vi.fn(async () => ({
        schemaVersion: 1 as const,
        availableBytes: 512 * 1024 * 1024,
        availableInodes: 65_536,
        requiredAvailableBytes: 256 * 1024 * 1024,
        requiredAvailableInodes: 16_384,
      })),
      now: () => "2026-08-14T00:00:00.000Z",
    } as unknown as PreparedM6ProjectEnvironmentOneTurnTaskV1;
  };

describe("M6 production Project Environment one-turn composition", () => {
  it("constructs a deterministic pre-Pi attempt binding from exact public, tool, and sandbox inputs", async () => {
    const task = await createTask();
    const first = createM6AgentAttemptBindingFromPreparedTaskV1(task);
    const repeated = createM6AgentAttemptBindingFromPreparedTaskV1(task);

    expect(repeated).toEqual(first);
    expect(first).toMatchObject({
      assignmentId: task.assignment.assignment.assignmentId,
      agentProjectionContentSha256:
        task.assignment.agentProjection.projectionContentSha256,
      publicTaskSpecSha256: task.assignment.agentProjection.publicTask.sha256,
      taskId: publicTask.taskId,
      provider: publicTask.agentBudget.provider,
      model: publicTask.agentBudget.model,
      thinkingLevel: publicTask.agentBudget.thinkingLevel,
      workspaceBaselineSelectedTreeSha256:
        task.workspace.receipt.selectedTreeSha256,
      taskBlindAdapterSha256: task.assignment.assignment.taskBlindAdapterSha256,
    });
    expect(JSON.stringify(first)).not.toMatch(/environmentRevision/iu);

    const changed = createM6AgentAttemptBindingFromPreparedTaskV1({
      ...task,
      sandboxRealization: { schemaVersion: 1, changed: true },
    });
    expect(changed.sandboxRealizationSha256).not.toBe(
      first.sandboxRealizationSha256,
    );
  });

  it("runs the frozen provider/model/prompt exactly once and returns no_candidate without relaunch", async () => {
    const task = await createTask();
    const runPiTurn = vi.fn(async (input: RunVNextPiSdkTurnOptions) => ({
      schemaVersion: 1 as const,
      status: "completed" as const,
      sessionId: "session:m6:test",
      sessionFile: join(task.layout.piSessionDirectory, "session.jsonl"),
      provider: input.provider,
      model: input.model,
      requestedThinkingLevel: input.thinkingLevel,
      realizedThinkingLevel: input.thinkingLevel,
      activeTools: input.tools.map((tool) => tool.name),
      assistantText: "No candidate was produced.",
      errorMessage: null,
      eventsObserved: 0,
      observedTurnCount: 1 as const,
      stats: {
        sessionFile: join(task.layout.piSessionDirectory, "session.jsonl"),
        sessionId: "session:m6:test",
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 2,
        tokens: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          total: 2,
        },
        cost: 0,
      },
    }));
    const runCompatibility = vi.fn(
      async (input: {
        readonly lineage: M6AdapterBuildCompatibilityLineageV1;
      }) => {
        const receipt = compatibilityReceipt(input.lineage);
        return {
          pendingBinding: {
            schemaVersion: 1,
            bindingId: "m6-binding:pending",
            lineage: input.lineage,
            compatibilityStatus: "pending",
            compatibilityReceiptId: null,
            createdAt: "2026-08-14T00:00:00.000Z",
            completedAt: null,
          },
          receipt,
          binding: {
            schemaVersion: 1,
            bindingId: "m6-binding:complete",
            lineage: input.lineage,
            compatibilityStatus: "compatible",
            compatibilityReceiptId: receipt.receiptId,
            createdAt: "2026-08-14T00:00:00.000Z",
            completedAt: "2026-08-14T00:00:01.000Z",
          },
        } as never;
      },
    );
    const close = vi.fn(async () => undefined);
    const port = createM6ProjectEnvironmentOneTurnAgentPortV1(task, {
      runPiTurn,
      runCompatibility: runCompatibility as never,
      createSidecar: () => ({}) as never,
      createRuntime: () => ({
        adapterBuildCompatibilityIdentity: vi.fn(),
        invoke: vi.fn(),
        close,
      }),
      extractPatch: vi.fn() as never,
    });
    const result = await runM6OneTurnAgentV1(
      createM6OneTurnRequestFromPreparedTaskV1(task),
      port,
    );

    expect(result.status).toBe("no_candidate");
    expect(task.assertTaskStorageHeadroom).toHaveBeenCalledTimes(1);
    expect(runPiTurn).toHaveBeenCalledTimes(1);
    expect(runCompatibility).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(runPiTurn.mock.calls[0]?.[0]).toMatchObject({
      provider: publicTask.agentBudget.provider,
      model: publicTask.agentBudget.model,
      thinkingLevel: publicTask.agentBudget.thinkingLevel,
      prompt: publicTask.goal,
      timeoutMs: publicTask.agentBudget.wallTimeMsMaximum,
    });
    expect(
      JSON.stringify(runCompatibility.mock.calls[0]?.[0].lineage),
    ).not.toMatch(/environmentRevision/iu);
    const recordWrite = vi.spyOn(task.records, "write");
    const headroomCallIndex = recordWrite.mock.calls.findIndex(
      ([kind]) => kind === "headroom",
    );
    const headroomPayload = recordWrite.mock.calls[headroomCallIndex]?.[1];
    const headroomReceipt =
      M6TaskStorageHeadroomReceiptV1Schema.parse(headroomPayload);
    expect(headroomReceipt).toMatchObject({
      recordKind: "m6-task-storage-headroom",
      assignmentId: task.assignment.assignment.assignmentId,
      taskId: task.taskId,
      attemptBindingContentSha256: asSha256DigestV1(
        contentHash(createM6AgentAttemptBindingFromPreparedTaskV1(task)),
      ),
      boundary: "pre_pi",
      availableBytes: 512 * 1024 * 1024,
      availableInodes: 65_536,
      requiredAvailableBytes: 256 * 1024 * 1024,
      requiredAvailableInodes: 16_384,
      observedAt: "2026-08-14T00:00:00.000Z",
    });
    expect(
      recordWrite.mock.invocationCallOrder[headroomCallIndex],
    ).toBeLessThan(runPiTurn.mock.invocationCallOrder[0]!);
  });

  it("fails closed before Pi when M6 headroom is below threshold", async () => {
    const task = await createTask();
    vi.mocked(task.assertTaskStorageHeadroom).mockResolvedValueOnce({
      schemaVersion: 1,
      availableBytes: 256 * 1024 * 1024,
      availableInodes: 16_383,
      requiredAvailableBytes: 256 * 1024 * 1024,
      requiredAvailableInodes: 16_384,
    });
    const runPiTurn = vi.fn();
    const runCompatibility = vi.fn(
      async (input: {
        readonly lineage: M6AdapterBuildCompatibilityLineageV1;
      }) => compatibleResult(input.lineage),
    );
    const port = createM6ProjectEnvironmentOneTurnAgentPortV1(task, {
      runPiTurn: runPiTurn as never,
      runCompatibility: runCompatibility as never,
      createSidecar: () => ({}) as never,
      createRuntime: () => ({
        adapterBuildCompatibilityIdentity: vi.fn(),
        invoke: vi.fn(),
        close: vi.fn(async () => undefined),
      }),
      extractPatch: vi.fn() as never,
    });

    await expect(
      runM6OneTurnAgentV1(createM6OneTurnRequestFromPreparedTaskV1(task), port),
    ).rejects.toThrow(/inode headroom/u);

    expect(runPiTurn).not.toHaveBeenCalled();
    expect(
      vi
        .spyOn(task.records, "write")
        .mock.calls.some(([kind]) => kind === "headroom"),
    ).toBe(false);
  });

  it("fails closed before Pi when the M6 headroom receipt cannot persist", async () => {
    const task = await createTask();
    vi.spyOn(task.records, "write").mockImplementation(
      async (kind, payload) => {
        if (kind === "headroom") {
          throw new Error("injected M6 headroom persistence failure");
        }
        return asSha256DigestV1(contentHash(payload));
      },
    );
    const runPiTurn = vi.fn();
    const runCompatibility = vi.fn(
      async (input: {
        readonly lineage: M6AdapterBuildCompatibilityLineageV1;
      }) => compatibleResult(input.lineage),
    );
    const port = createM6ProjectEnvironmentOneTurnAgentPortV1(task, {
      runPiTurn: runPiTurn as never,
      runCompatibility: runCompatibility as never,
      createSidecar: () => ({}) as never,
      createRuntime: () => ({
        adapterBuildCompatibilityIdentity: vi.fn(),
        invoke: vi.fn(),
        close: vi.fn(async () => undefined),
      }),
      extractPatch: vi.fn() as never,
    });

    await expect(
      runM6OneTurnAgentV1(createM6OneTurnRequestFromPreparedTaskV1(task), port),
    ).rejects.toThrow(/headroom persistence failure/u);

    expect(runPiTurn).not.toHaveBeenCalled();
  });
});
