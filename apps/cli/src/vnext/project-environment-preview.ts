import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  EnvironmentPublicationIntentV1Schema,
  ProjectAdapterCandidateReferenceV1Schema,
  ProjectToolchainReceiptV1Schema,
  asAdapterId,
  asBuildId,
  asEnvironmentBindingEpochId,
  asProjectAdapterCandidateId,
  asProjectEnvironmentId,
  asProjectEnvironmentOperationId,
  asProjectEnvironmentTaskId,
  asProjectEnvironmentTurnId,
  asProjectInitializationAttemptEventId,
  asProjectInitializationAttemptId,
  asProjectSessionId,
  asProjectToolchainReceiptId,
  asSha256DigestV1,
  asSourceId,
  asWorkspaceId,
  taskNamespaceDigestV1,
  type ProjectCapabilitySetV1,
  type ProjectAdapterRevisionV1,
  type ProjectEnvironmentRevisionV1,
  type ProjectTurnBudgetV1,
  type ProjectTurnUsageV1,
} from "@chronorift/domain";
import { loadProjectAdapterPackageV1 } from "@chronorift/godot-adapter";
import {
  ProjectEnvironmentStoreV1,
  ProjectEnvironmentTaskStoreV1,
  contentHash,
} from "@chronorift/json-artifacts";
import {
  createProjectEnvironmentGameToolDefinitions,
  createProjectEnvironmentToolCallAdmissionV1,
  createVNextCodingToolDefinitions,
  runProjectEnvironmentInteractivePiSessionV1,
  runVNextPiTurnWithSdk,
  type PiThinkingLevel,
} from "@chronorift/pi-harness";

import { SandboxPiCodingToolPort } from "./pi-coding-tool-port.js";
import { prepareProjectEnvironmentGodotBuildV1 } from "./candidate-godot-build.js";
import type { SecurityEventV1 } from "./contracts.js";
import {
  freezeProjectAdapterCandidateV1,
  initializeProjectAdapterCandidateWorkspaceV1,
} from "./project-adapter-candidate.js";
import { validateProjectAdapterCandidateV1 } from "./project-environment-conformance.js";
import { createProjectEnvironmentConformanceDriverV1 } from "./project-environment-conformance-driver.js";
import {
  ProjectEnvironmentGameRuntimeV1,
  type ProjectEnvironmentRuntimeBuildV1,
} from "./project-environment-game-runtime.js";
import { composeProjectEnvironmentCompatibleRuntimeV1 } from "./project-environment-runtime-composition.js";
import {
  defaultProjectEnvironmentHostConfigPath,
  readProjectEnvironmentHostConfigV1,
  resolveProjectEnvironmentGodotToolchainV1,
} from "./project-environment-host-config.js";
import {
  initializeProjectEnvironmentV1,
  enforceProjectEnvironmentTurnBudgetV1,
  projectEnvironmentPiTurnExceptionResultV1,
  projectEnvironmentTurnTimeoutMsV1,
  type ProjectEnvironmentAuthoritativeValidationV1,
  type ProjectEnvironmentInitializationPortV1,
  type ProjectEnvironmentPiTurnResultV1,
} from "./project-environment-initialization.js";
import { prepareProjectEnvironmentProjectStoreV1 } from "./project-environment-project-store.js";
import {
  bindPublishedProjectEnvironmentV1,
  publishInitialProjectEnvironmentV1,
  resolveInitialProjectEnvironmentPublicationV1,
} from "./project-environment-publication.js";
import { reconcilePendingProjectEnvironmentPublicationFromRuntimeRootV1 } from "./project-environment-publication-recovery.js";
import {
  bindReusableProjectEnvironmentRevisionV1,
  inspectReusableProjectEnvironmentRevisionV1,
  runReusedProjectEnvironmentGoalV1,
} from "./project-environment-reuse.js";
import { GodotProjectEnvironmentSidecarPortV1 } from "./project-environment-sidecar-port.js";
import { preflightManagedGodotProjectEnvironmentRuntimeV1 } from "./managed-godot-project-environment-runtime-preflight.js";
import {
  createDuplexBwrapCgroupTaskSandbox,
  type DuplexTaskSandboxBrokerV1,
} from "./sandbox-broker.js";
import {
  createSandboxPolicyV1,
  createSandboxPolicyV2,
} from "./sandbox-policy.js";
import {
  createSandboxTaskRuntimeRoot,
  preflightSandboxHost,
} from "./sandbox-preflight.js";
import { inspectSandboxToolchain } from "./sandbox-toolchain.js";
import { preflightCleanProjectEnvironmentV1 } from "./source-preflight.js";
import { createProjectEnvironmentTaskDirectoryLayout } from "./task-paths.js";
import { materializePrivateTaskWorkspace } from "./workspace-materializer.js";

const DEFAULT_BUDGET = Object.freeze({
  schemaVersion: 1,
  wallTimeMs: 1_800_000,
  toolCallLimit: 256,
  runtimeTimeMs: 600_000,
  tokenPolicy: "observe_only",
  tokenLimit: null,
  storageByteLimit: 1_073_741_824,
  storageInodeLimit: 131_072,
}) satisfies ProjectTurnBudgetV1;

const hash = (label: string, value: unknown): string =>
  contentHash({
    schemaVersion: 1,
    label,
    value: JSON.parse(JSON.stringify(value)) as never,
  });

export interface ProjectEnvironmentPreviewRequestV1 {
  readonly projectPath: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: PiThinkingLevel;
  readonly goal: string | null;
  readonly hostConfigPath?: string | undefined;
  readonly agentDir?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly interactive?: boolean | undefined;
  readonly budget?: ProjectTurnBudgetV1 | undefined;
}

export interface ProjectEnvironmentPreviewResultV1 {
  readonly schemaVersion: 1;
  readonly status: "ready" | "failed";
  readonly taskId: string;
  readonly sessionId: string;
  readonly sessionFile: string | null;
  readonly environmentId: string;
  readonly environmentRevisionId: string | null;
  readonly adapterRevisionId: string | null;
  readonly buildId: string | null;
  readonly candidateSourceChanged: boolean;
  readonly runtimeObservationReceiptId: string | null;
  readonly reused: boolean;
  readonly goalDelivered: boolean;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly taskDirectory: string;
  readonly projectNamespace: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: PiThinkingLevel;
  readonly limitations: readonly string[];
}

export interface ProjectEnvironmentPreviewDependenciesV1 {
  readonly runPiTurn: typeof runVNextPiTurnWithSdk;
}

const DEFAULT_PROJECT_ENVIRONMENT_PREVIEW_DEPENDENCIES_V1: ProjectEnvironmentPreviewDependenciesV1 =
  Object.freeze({ runPiTurn: runVNextPiTurnWithSdk });

const usage = (
  wallStartedAt: number,
  result: Awaited<ReturnType<typeof runVNextPiTurnWithSdk>>,
): ProjectTurnUsageV1 => ({
  schemaVersion: 1,
  wallTimeMs: Math.max(0, Math.round(performance.now() - wallStartedAt)),
  toolCalls: result.stats.toolCalls,
  runtimeTimeMs: null,
  inputTokens: result.stats.tokens.input,
  outputTokens: result.stats.tokens.output,
  storageBytes: null,
  storageInodes: null,
});

const mapPiTurn = (
  startedAt: number,
  result: Awaited<ReturnType<typeof runVNextPiTurnWithSdk>>,
): ProjectEnvironmentPiTurnResultV1 => ({
  status:
    result.status === "completed"
      ? "completed"
      : result.status === "aborted"
        ? "cancelled"
        : "failed",
  sessionId: asProjectSessionId(result.sessionId),
  usageStatus: "partial",
  usage: usage(startedAt, result),
  errorCode: result.status === "completed" ? null : result.status,
  errorMessage: result.errorMessage,
});

const managedRuntimeTargets = (runtime: {
  readonly capability: {
    readonly toolchain: {
      readonly files: readonly { readonly target: string }[];
    };
    readonly fontconfigTarget: string;
    readonly addonParentTarget: string;
    readonly addonTarget: string;
    readonly overlayTarget: string;
    readonly adapterParentTarget: string;
    readonly adapterTarget: string;
  };
}): readonly string[] => [
  ...runtime.capability.toolchain.files.map((file) => file.target),
  runtime.capability.fontconfigTarget,
  runtime.capability.addonParentTarget,
  runtime.capability.addonTarget,
  runtime.capability.overlayTarget,
  runtime.capability.adapterParentTarget,
  runtime.capability.adapterTarget,
];

/**
 * Explicit Preview composition. It does not replace the default ChronoRift
 * entry point and it publishes only after the Pi turn returns and Host
 * conformance succeeds.
 */
export async function runProjectEnvironmentPreviewV1(
  request: ProjectEnvironmentPreviewRequestV1,
  dependencies: ProjectEnvironmentPreviewDependenciesV1 = DEFAULT_PROJECT_ENVIRONMENT_PREVIEW_DEPENDENCIES_V1,
): Promise<ProjectEnvironmentPreviewResultV1> {
  const hostConfig = await readProjectEnvironmentHostConfigV1(
    request.hostConfigPath ?? defaultProjectEnvironmentHostConfigPath(),
  );
  const runtimeRoot = await createSandboxTaskRuntimeRoot(
    hostConfig.taskStorageRoot,
    hostConfig.runtimeRoot,
  );
  const source = await preflightCleanProjectEnvironmentV1({
    projectPath: request.projectPath,
    sourceRepositoryExclusionRoots: [hostConfig.taskStorageRoot],
  });
  const project = await prepareProjectEnvironmentProjectStoreV1(source);
  const environmentIdentity = hash("project-environment", source.projectRoot);
  const environmentId = asProjectEnvironmentId(
    `environment:v1:${environmentIdentity}`,
  );
  const sourceId = asSourceId(`source:v1:${source.projectSourceIdentity}`);
  const adapterId = asAdapterId(
    `adapter.pea.${environmentIdentity.slice(0, 48)}`,
  );
  const projectStore = new ProjectEnvironmentStoreV1({
    namespaceRoot: project.namespaceRoot,
    environmentId,
  });
  await projectStore.create();
  const recovery =
    await reconcilePendingProjectEnvironmentPublicationFromRuntimeRootV1({
      projectStore,
      runtimeRoot,
      inspectedSourceId: sourceId,
    });
  if (recovery !== null) {
    const committed = recovery.resolution.publicationCommitted;
    return Object.freeze({
      schemaVersion: 1,
      status: "failed",
      taskId: recovery.authority.taskId,
      sessionId: recovery.authority.sessionId,
      sessionFile: null,
      environmentId,
      environmentRevisionId: committed
        ? recovery.authority.targetEnvironmentRevisionId
        : null,
      adapterRevisionId: committed
        ? recovery.authority.targetAdapterRevisionId
        : null,
      buildId: null,
      candidateSourceChanged: false,
      runtimeObservationReceiptId: null,
      reused: false,
      goalDelivered: false,
      failureCode:
        recovery.resolution.outcome === "succeeded"
          ? "publication_reconciled_rerun_required"
          : recovery.resolution.failureCode,
      failureMessage:
        recovery.resolution.outcome === "succeeded"
          ? "The interrupted publication was recovered exactly; rerun Preview to start new user work. No queued goal was delivered during recovery."
          : recovery.resolution.failureMessage,
      taskDirectory: join(
        runtimeRoot,
        "tasks",
        taskNamespaceDigestV1(recovery.authority.taskId),
      ),
      projectNamespace: project.namespaceRoot,
      provider: request.provider,
      model: request.model,
      thinkingLevel: request.thinkingLevel,
      limitations: Object.freeze([
        "This command reconciled one prior PE-A publication and did not resume its Pi Session or deliver any queued goal.",
        ...(recovery.partialRevisionQuarantined
          ? ["The interrupted partial revision was quarantined."]
          : []),
      ]),
    });
  }

  const sandbox = await preflightSandboxHost({
    delegatedCgroupRoot: hostConfig.delegatedCgroupRoot,
    bwrapPath: hostConfig.bwrapPath,
    prlimitPath: hostConfig.prlimitPath,
    busyboxPath: hostConfig.busyboxPath,
    taskStorageRoot: hostConfig.taskStorageRoot,
  });
  if (sandbox.kind !== "supported") {
    throw new Error(
      `Project Environment sandbox preflight failed: ${JSON.stringify(sandbox.receipt.blockers)}`,
    );
  }
  const godot = await resolveProjectEnvironmentGodotToolchainV1(
    hostConfig,
    source.requestedGodotVersion,
  );
  const taskId = asProjectEnvironmentTaskId(randomUUID());
  const attemptId = asProjectInitializationAttemptId(
    `attempt.v1.${randomUUID()}`,
  );
  const sessionId = asProjectSessionId(randomUUID());
  const operationId = asProjectEnvironmentOperationId(
    `publication.v1.${randomUUID()}`,
  );
  const bindingEpochId = asEnvironmentBindingEpochId(
    `binding.v1.${randomUUID()}`,
  );
  const layout = await createProjectEnvironmentTaskDirectoryLayout({
    runtimeRoot,
    sourceRepositoryRoot: source.repositoryRoot,
    taskId,
  });
  await materializePrivateTaskWorkspace({ taskId, source, layout });

  const taskStore = new ProjectEnvironmentTaskStoreV1({
    storeRoot: layout.projectEnvironmentRecordDirectory,
    taskId,
  });
  await taskStore.create();

  const codingToolchain = await inspectSandboxToolchain({
    lddPath: hostConfig.lddPath,
    commands: [
      { target: "/bin/bash", hostPath: hostConfig.bashPath },
      { target: "/usr/bin/rg", hostPath: hostConfig.rgPath },
      { target: "/usr/bin/find", hostPath: hostConfig.findPath },
      { target: "/usr/bin/ls", hostPath: hostConfig.lsPath },
    ],
  });
  const codingPolicy = createSandboxPolicyV1(
    sandbox.capability.runtimeIdentity,
    {
      toolchainId: codingToolchain.capability.toolchainId,
      targets: codingToolchain.capability.files.map((file) => file.target),
    },
  );
  const securityEvents: SecurityEventV1[] = [];
  let broker: DuplexTaskSandboxBrokerV1 =
    await createDuplexBwrapCgroupTaskSandbox({
      taskId,
      capability: sandbox.capability,
      hostBinding: sandbox.binding,
      policy: codingPolicy,
      toolchain: codingToolchain,
      layout,
      securityEvents: (event) => {
        securityEvents.push(event);
        return Promise.resolve();
      },
    });
  let sessionFile: string | undefined;
  let validationCapabilitySet: ProjectCapabilitySetV1 | undefined;
  let validationRuntime:
    | Awaited<
        ReturnType<typeof preflightManagedGodotProjectEnvironmentRuntimeV1>
      >
    | undefined;
  let authoritative: ProjectEnvironmentAuthoritativeValidationV1 | undefined;
  let gameRuntime: ProjectEnvironmentGameRuntimeV1 | undefined;
  let activeBuild: ProjectEnvironmentRuntimeBuildV1 | undefined;
  let runtimeObservationReceiptId: string | undefined;
  let validatedAdapterPackage:
    Awaited<ReturnType<typeof loadProjectAdapterPackageV1>> | undefined;
  let boundEnvironmentRevision: ProjectEnvironmentRevisionV1 | undefined;
  let boundAdapterRevision: ProjectAdapterRevisionV1 | undefined;

  const toolchainIdentity = {
    schemaVersion: 1 as const,
    requested: {
      schemaVersion: 1 as const,
      engineFamily: "godot",
      versionRequirement: "4.7.1",
      platform: "linux-x86_64",
      requiredFeatures: [...godot.receipt.buildFeatures],
    },
    status: "realized" as const,
    realized: {
      schemaVersion: 1 as const,
      engineFamily: "godot",
      version: godot.receipt.realizedVersion,
      platform: godot.receipt.platform,
      artifactDigest: godot.receipt.executableSha256,
      features: [...godot.receipt.buildFeatures],
      renderer: godot.receipt.renderer,
    },
    limitations: [] as const,
  };
  const toolchainContent = {
    ...toolchainIdentity,
    observedAt: new Date().toISOString(),
  };
  const toolchainReceipt = ProjectToolchainReceiptV1Schema.parse({
    ...toolchainContent,
    receiptId: asProjectToolchainReceiptId(
      `toolchain-receipt:v1:${hash("toolchain-receipt", toolchainIdentity)}`,
    ),
  });
  await taskStore.putToolchainReceiptOnce(toolchainReceipt);

  const activateManagedRuntime = async (
    adapterFiles: readonly {
      readonly relativePath: string;
      readonly bytes: Uint8Array;
    }[],
  ) => {
    const codingCleanup = await broker.cleanup();
    if (
      !codingCleanup.processGroupTerminated ||
      codingCleanup.cgroupPopulated ||
      !codingCleanup.scopeRemoved ||
      (sandbox.capability.taskStorage !== undefined &&
        codingCleanup.storageReconciled !== true)
    ) {
      throw new Error(
        "Project Environment coding sandbox cleanup was incomplete before managed runtime activation",
      );
    }
    validationRuntime = await preflightManagedGodotProjectEnvironmentRuntimeV1({
      hostConfig,
      godot,
      adapterFiles,
    });
    const managedPolicy = createSandboxPolicyV2(
      sandbox.capability.runtimeIdentity,
      {
        coding: {
          toolchainId: codingToolchain.capability.toolchainId,
          targets: codingToolchain.capability.files.map((file) => file.target),
        },
        godot: {
          toolchainId: validationRuntime.capability.toolchain.toolchainId,
          managedRuntimeId: validationRuntime.capability.managedRuntimeId,
          targets: managedRuntimeTargets(validationRuntime),
        },
      },
    );
    broker = await createDuplexBwrapCgroupTaskSandbox({
      taskId,
      capability: sandbox.capability,
      hostBinding: sandbox.binding,
      policy: managedPolicy,
      toolchain: codingToolchain,
      managedRuntime: validationRuntime,
      layout,
      securityEvents: (event) => {
        securityEvents.push(event);
        return Promise.resolve();
      },
    });
    return managedPolicy;
  };

  const currentPointer = await projectStore.readCurrent();
  const currentRevision =
    currentPointer === null
      ? null
      : await projectStore.readRevision(
          currentPointer.environmentRevisionId,
          currentPointer.publicationOperationId,
        );
  const reusable =
    currentRevision === null
      ? null
      : inspectReusableProjectEnvironmentRevisionV1({
          revision: currentRevision.payload,
          files: currentRevision.files,
          expectedSourceId: sourceId,
          expectedToolchainReceiptId: toolchainReceipt.receiptId,
          expectedAdapterId: adapterId,
          expectedMainScene: source.mainScene,
        });
  if (reusable === null) {
    await initializeProjectAdapterCandidateWorkspaceV1({
      workspaceDirectory: layout.workspaceDirectory,
      taskId,
      projectSourceIdentity: source.projectSourceIdentity,
      adapterId,
      mainScene: source.mainScene,
    });
  }

  const createCompatibleGameRuntime = async (input: {
    readonly revision: ProjectEnvironmentRevisionV1;
    readonly adapterRevision: ProjectAdapterRevisionV1;
    readonly adapterPackage: Awaited<
      ReturnType<typeof loadProjectAdapterPackageV1>
    >;
    readonly bindingEpochId: ReturnType<typeof asEnvironmentBindingEpochId>;
    readonly policyProfileDigest: ReturnType<typeof asSha256DigestV1>;
  }): Promise<{
    readonly build: ProjectEnvironmentRuntimeBuildV1;
    readonly runtime: ProjectEnvironmentGameRuntimeV1;
  }> => {
    const managedRuntime = validationRuntime;
    if (managedRuntime === undefined) {
      throw new Error(
        "managed Project Environment runtime was not retained for compatibility",
      );
    }
    const target = input.adapterPackage.manifest.launchTargets.find(
      (candidate) => candidate.default,
    );
    if (target === undefined) {
      throw new Error("Validated ProjectAdapter lost its default target");
    }
    const prepareBuild = () =>
      prepareProjectEnvironmentGodotBuildV1({
        taskId,
        workspaceId: asWorkspaceId(`workspace.v1.${taskId}`),
        workspaceDirectory: layout.workspaceDirectory,
        baselineSourceHash: source.selectedTreeSha256,
        bindingEpochId: input.bindingEpochId,
        environment: {
          schemaVersion: 1,
          environmentId,
          environmentRevisionId: input.revision.environmentRevisionId,
          sourceId: input.revision.sourceId,
          adapterRevisionId: input.revision.adapterRevisionId,
          sdkDigest: input.revision.sdkDigest,
          bridgeDigest: input.revision.bridgeDigest,
          toolchainReceiptId: input.revision.toolchainReceiptId,
          conformanceReceiptId: input.revision.conformanceReceiptId,
          observerEffectReceiptId: input.revision.observerEffectReceiptId,
          policyProfileDigest: input.revision.policyProfileDigest,
          contentDigest: input.revision.contentDigest,
        },
        adapter: input.adapterRevision,
        toolchainArtifactDigest: godot.receipt.executableSha256,
        policyProfileDigest: input.policyProfileDigest,
        now: new Date().toISOString(),
      });
    const composeRuntime = (
      build: ProjectEnvironmentRuntimeBuildV1,
      resolveCompatibleBuild?: () => Promise<ProjectEnvironmentRuntimeBuildV1>,
    ): ProjectEnvironmentGameRuntimeV1 =>
      new ProjectEnvironmentGameRuntimeV1({
        sidecar: new GodotProjectEnvironmentSidecarPortV1({
          broker,
          managedRuntime,
        }),
        managedRuntime: managedRuntime.capability,
        adapterPackage: input.adapterPackage,
        capabilitySet: input.adapterRevision.capabilitySet,
        taskId,
        sourceClosureId: build.sourceClosureId,
        environmentRevisionId: input.revision.environmentRevisionId,
        adapterRevisionId: input.adapterRevision.adapterRevisionId,
        buildId: build.buildId,
        candidateSourceHash: build.candidateSourceHash,
        expectedMainScene: build.expectedMainScene,
        adapterManifestSha256: input.adapterPackage.manifestSha256,
        sdkSha256: managedRuntime.sdkDigest,
        bridgeSha256: managedRuntime.bridgeDigest,
        toolchainSha256: godot.receipt.executableSha256,
        engineVersion: managedRuntime.capability.engineVersion,
        ...(resolveCompatibleBuild === undefined
          ? {}
          : {
              resolveCompatibleBuild,
              persistPinnedCapture: async (capture, records) => {
                if (
                  capture.taskId !== taskId ||
                  capture.environmentRevisionId !==
                    input.revision.environmentRevisionId ||
                  capture.adapterRevisionId !==
                    input.adapterRevision.adapterRevisionId ||
                  capture.buildId !== activeBuild?.buildId
                ) {
                  throw new Error(
                    "Pinned capture does not belong to the final active Project Environment Build",
                  );
                }
                await taskStore.putPinnedCaptureOnce(capture, records);
              },
              persistRuntimeObservation: async (receipt) => {
                if (
                  receipt.taskId !== taskId ||
                  receipt.environmentRevisionId !==
                    input.revision.environmentRevisionId ||
                  receipt.adapterRevisionId !==
                    input.adapterRevision.adapterRevisionId ||
                  receipt.buildId !== activeBuild?.buildId
                ) {
                  throw new Error(
                    "Runtime observation does not belong to the final active Project Environment Build",
                  );
                }
                await taskStore.putRuntimeObservationReceiptOnce(receipt);
                runtimeObservationReceiptId = receipt.receiptId;
              },
            }),
      });
    const composition = composeProjectEnvironmentCompatibleRuntimeV1({
      taskStore,
      taskId,
      revision: input.revision,
      adapterRevision: input.adapterRevision,
      toolchainReceiptId: toolchainReceipt.receiptId,
      launchTargetId: target.targetId,
      prepareBuild,
      createRuntime: composeRuntime,
      onResolved: (build) => {
        activeBuild = build;
      },
    });
    return composition.resolve();
  };

  const runTurn: ProjectEnvironmentInitializationPortV1["runTurn"] = async (
    turn,
  ) => {
    const toolCallAdmission = createProjectEnvironmentToolCallAdmissionV1(
      turn.budget.toolCallLimit,
    );
    const codingTools = createVNextCodingToolDefinitions(
      new SandboxPiCodingToolPort(broker),
      { toolCallAdmission },
    );
    const gameTools =
      turn.purpose === "user_goal" && validationCapabilitySet !== undefined
        ? createProjectEnvironmentGameToolDefinitions(
            gameRuntime ??
              (() => {
                throw new Error(
                  "Project Environment runtime was not composed after validation",
                );
              })(),
            validationCapabilitySet,
            { toolCallAdmission },
          )
        : [];
    const startedAt = performance.now();
    let result: Awaited<ReturnType<typeof runVNextPiTurnWithSdk>>;
    try {
      result = await dependencies.runPiTurn({
        resourceWorkspaceDirectory: layout.workspaceDirectory,
        sessionDirectory: layout.piSessionDirectory,
        ...(sessionFile === undefined
          ? { newSessionId: sessionId }
          : { resumeSessionFile: sessionFile }),
        ...(request.agentDir === undefined
          ? {}
          : { agentDir: request.agentDir }),
        provider: request.provider,
        model: request.model,
        thinkingLevel: request.thinkingLevel,
        prompt: turn.prompt,
        tools: Object.freeze([...codingTools, ...gameTools]),
        timeoutMs: projectEnvironmentTurnTimeoutMsV1(
          request.timeoutMs,
          turn.budget,
        ),
        loadProjectAdapterSkillV1:
          turn.purpose === "environment_initialization",
        additionalEnvironmentInstructions:
          turn.purpose === "user_goal" &&
          boundEnvironmentRevision !== undefined &&
          boundAdapterRevision !== undefined
            ? [
                "Project Environment binding:",
                `- taskId: ${taskId}`,
                `- environmentRevisionId: ${boundEnvironmentRevision.environmentRevisionId}`,
                `- adapterRevisionId: ${boundAdapterRevision.adapterRevisionId}`,
                `- compatibleBuildIdAtTurnStart: ${activeBuild?.buildId ?? "unavailable"}`,
                "- The game tools declared by the frozen ProjectAdapter capability set and admitted by Host policy are registered for this Task.",
                "- When no game runtime is active, game_capabilities freezes the current workspace, runs the exact Adapter compatibility smoke if this Build is new, persists its receipt, and returns the buildId that game_launch accepts.",
                "- After editing source, call game_capabilities and use its returned exact buildId; compatibility failure is reported instead of silently launching changed bytes.",
              ].join("\n")
            : undefined,
      });
    } catch (error) {
      if (!toolCallAdmission.exhausted) throw error;
      return enforceProjectEnvironmentTurnBudgetV1(
        {
          status: "failed",
          sessionId: turn.sessionId,
          usageStatus: "partial",
          usage: {
            schemaVersion: 1,
            wallTimeMs: Math.max(0, Math.round(performance.now() - startedAt)),
            toolCalls: toolCallAdmission.attempted,
            runtimeTimeMs: null,
            inputTokens: null,
            outputTokens: null,
            storageBytes: null,
            storageInodes: null,
          },
          errorCode: "budget_exhausted",
          errorMessage:
            error instanceof Error ? error.message : "Pi tool call failed",
        },
        turn.budget,
        { toolCallAdmissionExhausted: true },
      );
    }
    sessionFile = result.sessionFile;
    const mapped = mapPiTurn(startedAt, result);
    const withAdmissionUsage =
      mapped.usage === null ||
      mapped.usage.toolCalls === null ||
      mapped.usage.toolCalls >= toolCallAdmission.attempted
        ? mapped
        : {
            ...mapped,
            usage: {
              ...mapped.usage,
              toolCalls: toolCallAdmission.attempted,
            },
          };
    return enforceProjectEnvironmentTurnBudgetV1(
      withAdmissionUsage,
      turn.budget,
      { toolCallAdmissionExhausted: toolCallAdmission.exhausted },
    );
  };

  const port: ProjectEnvironmentInitializationPortV1 = {
    appendAttemptEvent: async (event) => {
      await taskStore.appendAttemptEvent(event);
    },
    putTurn: async (turn) => {
      await taskStore.appendTurn(turn);
    },
    runTurn,
    assertGameSourceUnchanged: async () => {
      const observed = await preflightCleanProjectEnvironmentV1({
        projectPath: source.projectRoot,
        sourceRepositoryExclusionRoots: [hostConfig.taskStorageRoot],
      });
      if (observed.projectSourceIdentity !== source.projectSourceIdentity) {
        throw new Error(
          "Host project source changed during PE-A initialization",
        );
      }
    },
    freezeCandidate: async () => {
      const frozen = await freezeProjectAdapterCandidateV1({
        workspaceDirectory: layout.workspaceDirectory,
        taskId,
        projectSourceIdentity: source.projectSourceIdentity,
      });
      const candidate = ProjectAdapterCandidateReferenceV1Schema.parse({
        schemaVersion: 1,
        taskId,
        attemptId,
        candidateId: asProjectAdapterCandidateId(
          `candidate:v1:${frozen.candidateSha256}`,
        ),
        adapterId,
        sourceId,
        contentDigest: frozen.candidateSha256,
        fileCount: frozen.fileCount,
        byteLength: frozen.byteLength,
        frozenAt: new Date().toISOString(),
      });
      await taskStore.putCandidateOnce(
        candidate,
        frozen.files.map((file) => ({
          path: file.relativePath,
          bytes: file.bytes,
        })),
      );
      return candidate;
    },
    validateCandidate: async (candidate) => {
      const stored = await taskStore.readCandidate(candidate.candidateId);
      const candidateFiles = stored.files.map((file) => ({
        path: file.path,
        bytes: file.bytes,
      }));
      const loaded = await loadProjectAdapterPackageV1(
        `${layout.workspaceDirectory}/.chronorift/adapter-candidate`,
        {
          requireSingleLaunchTarget: true,
          expectedMainScene: source.mainScene,
          requireEmptyLaunchParameters: true,
        },
      );
      validatedAdapterPackage = loaded;
      const managedPolicy = await activateManagedRuntime(
        candidateFiles.map((file) => ({
          relativePath: file.path,
          bytes: file.bytes,
        })),
      );
      if (validationRuntime === undefined) {
        throw new Error("managed Project Environment runtime was not realized");
      }
      const sidecar = new GodotProjectEnvironmentSidecarPortV1({
        broker,
        managedRuntime: validationRuntime,
      });
      const driver = createProjectEnvironmentConformanceDriverV1({
        sidecar,
        managedRuntime: validationRuntime.capability,
        taskId,
        sourceClosureId: sourceId,
        environmentRevisionId: `environment-candidate:v1:${candidate.contentDigest}`,
        adapterRevisionId: `adapter-revision:v1:${candidate.contentDigest}`,
        buildId: `build.v1.${source.projectSourceIdentity.slice(0, 48)}`,
        candidateSourceHash: source.selectedTreeSha256,
        expectedMainScene: source.mainScene,
        adapterManifestSha256: loaded.manifestSha256,
        sdkSha256: validationRuntime.sdkDigest,
        bridgeSha256: validationRuntime.bridgeDigest,
        toolchainSha256: godot.receipt.executableSha256,
        engineVersion: validationRuntime.capability.engineVersion,
      });
      const validated = await validateProjectAdapterCandidateV1(
        {
          candidateDirectory: `${layout.workspaceDirectory}/.chronorift/adapter-candidate`,
          candidateFiles,
          candidate,
          adapterId,
          environmentId,
          publicationOperationId: operationId,
          toolchainReceiptId: toolchainReceipt.receiptId,
          expectedMainScene: source.mainScene,
          sdkDigest: validationRuntime.sdkDigest,
          bridgeDigest: validationRuntime.bridgeDigest,
          policyProfileDigest: asSha256DigestV1(
            contentHash(managedPolicy as never),
          ),
        },
        driver,
      );
      const completedAt = validated.conformance.completedAt;
      validationCapabilitySet = validated.adapterRevision.capabilitySet;
      await Promise.all([
        taskStore.putConformanceReceiptOnce(validated.conformance),
        taskStore.putObserverEffectReceiptOnce(validated.observerEffect),
      ]);
      const publicationIntent = EnvironmentPublicationIntentV1Schema.parse({
        schemaVersion: 1,
        operationId,
        taskId,
        attemptId,
        environmentId,
        candidateId: candidate.candidateId,
        sourceId,
        targetEnvironmentRevisionId:
          validated.environmentRevision.environmentRevisionId,
        targetAdapterRevisionId: validated.adapterRevision.adapterRevisionId,
        expectedCurrentRevisionId: null,
        targetContentDigest: validated.environmentRevision.contentDigest,
        createdAt: completedAt,
      });
      authoritative = Object.freeze({
        candidate,
        conformance: validated.conformance,
        adapterRevision: validated.adapterRevision,
        environmentRevision: validated.environmentRevision,
        publicationIntent,
        revisionFiles: validated.revisionFiles,
      });
      return authoritative;
    },
    publish: (validation) =>
      publishInitialProjectEnvironmentV1({
        taskStore,
        projectStore,
        intent: validation.publicationIntent,
        sessionId,
        bindingEpochId,
        revision: validation.environmentRevision,
        revisionFiles: validation.revisionFiles,
        pointerCommitRequestedAt: new Date().toISOString(),
        now: () => new Date().toISOString(),
      }),
    bind: async ({ validation, publication, bindingEpochId }) => {
      if (validatedAdapterPackage === undefined) {
        throw new Error(
          "Project Environment validation runtime was not retained for compatibility",
        );
      }
      const compatible = await createCompatibleGameRuntime({
        revision: validation.environmentRevision,
        adapterRevision: validation.adapterRevision,
        adapterPackage: validatedAdapterPackage,
        bindingEpochId,
        policyProfileDigest: validation.environmentRevision.policyProfileDigest,
      });
      const binding = await bindPublishedProjectEnvironmentV1({
        taskStore,
        taskId,
        attemptId,
        bindingEpochId,
        ordinal: 0,
        revision: validation.environmentRevision,
        publication,
        createdAt: publication.completedAt,
        boundAt: new Date().toISOString(),
      });
      activeBuild = compatible.build;
      gameRuntime = compatible.runtime;
      boundEnvironmentRevision = validation.environmentRevision;
      boundAdapterRevision = validation.adapterRevision;
      return binding;
    },
    resolvePublication: async ({
      validation,
      publication,
      binding,
      attempt,
    }) => {
      await taskStore.putInitializationAttemptOnce(attempt);
      await resolveInitialProjectEnvironmentPublicationV1({
        projectStore,
        intent: validation.publicationIntent,
        attempt,
        publication,
        binding,
        resolvedAt: new Date().toISOString(),
      });
    },
  };

  let ready = false;
  let goalDelivered = false;
  let reused = false;
  let previewFailed = false;
  let failureCode: string | null = null;
  let failureMessage: string | null = null;
  const additionalLimitations: string[] = [];
  const recordPreviewFailure = (
    error: unknown,
    fallbackCode = "project_preview_failed",
  ): void => {
    const failure = projectEnvironmentPiTurnExceptionResultV1(error, sessionId);
    const code =
      failure.errorCode === "pi_turn_exception"
        ? fallbackCode
        : (failure.errorCode ?? fallbackCode);
    const message =
      failure.errorMessage ?? "Project Environment Preview failed";
    previewFailed = true;
    goalDelivered = false;
    if (failureCode === null) {
      failureCode = code;
      failureMessage = message;
    } else {
      additionalLimitations.push(`Additional failure (${code}): ${message}`);
    }
  };
  try {
    if (reusable === null) {
      const result = await initializeProjectEnvironmentV1(
        {
          taskId,
          sessionId,
          sourceId,
          adapterId,
          sourceIdentity: source.projectSourceIdentity,
          mainScene: source.mainScene,
          requestedGodotVersion: source.requestedGodotVersion,
          providerId: request.provider,
          modelId: request.model,
          thinkingLevel: request.thinkingLevel,
          budget: request.budget ?? DEFAULT_BUDGET,
          queuedGoal: request.goal,
          ids: {
            attemptId,
            initializationTurnId: asProjectEnvironmentTurnId(
              `turn.init.${randomUUID()}`,
            ),
            goalTurnId: asProjectEnvironmentTurnId(`turn.goal.${randomUUID()}`),
            bindingEpochId,
            attemptEventId: (sequence) =>
              asProjectInitializationAttemptEventId(
                `attempt-event.${sequence}.${randomUUID()}`,
              ),
          },
        },
        port,
      );
      await taskStore.putInitializationAttemptOnce(result.attempt);
      ready = result.attempt.state === "succeeded";
      goalDelivered = result.goalDelivered;
      if (!ready) {
        failureCode = result.attempt.terminalCode;
        failureMessage = result.attempt.terminalMessage;
      } else if (!goalDelivered && result.goalTurn !== null) {
        failureCode = result.goalTurn.terminalCode;
        failureMessage = result.goalTurn.terminalMessage;
      }
    } else {
      const managedPolicy = await activateManagedRuntime(reusable.adapterFiles);
      if (validationRuntime === undefined) {
        throw new Error("managed Project Environment runtime was not realized");
      }
      const policyProfileDigest = asSha256DigestV1(
        contentHash(managedPolicy as never),
      );
      if (
        validationRuntime.sdkDigest !== reusable.revision.sdkDigest ||
        validationRuntime.bridgeDigest !== reusable.revision.bridgeDigest ||
        policyProfileDigest !== reusable.revision.policyProfileDigest
      ) {
        throw new Error(
          "current Project Environment revision requires review because SDK, bridge, or sandbox policy changed",
        );
      }
      validatedAdapterPackage = reusable.adapterPackage;
      validationCapabilitySet = reusable.adapterRevision.capabilitySet;
      const compatible = await createCompatibleGameRuntime({
        revision: reusable.revision,
        adapterRevision: reusable.adapterRevision,
        adapterPackage: reusable.adapterPackage,
        bindingEpochId,
        policyProfileDigest,
      });
      const buildBinding = await taskStore.readBuildBinding(
        asBuildId(compatible.build.buildId),
      );
      if (
        buildBinding.compatibilityStatus !== "compatible" ||
        buildBinding.compatibilityReceiptId === null
      ) {
        throw new Error(
          "compatible Build resolver did not persist its exact compatibility binding",
        );
      }
      const compatibility = await taskStore.readCompatibilityReceipt(
        buildBinding.compatibilityReceiptId,
      );
      const observedCurrent = await projectStore.readCurrent();
      if (
        observedCurrent?.environmentRevisionId !==
          reusable.revision.environmentRevisionId ||
        observedCurrent.publicationOperationId !==
          reusable.revision.publicationOperationId
      ) {
        throw new Error(
          "Project Environment current revision changed during reuse smoke",
        );
      }
      await bindReusableProjectEnvironmentRevisionV1({
        taskStore,
        taskId,
        sessionId,
        bindingEpochId,
        revision: reusable.revision,
        observedCurrentRevisionId: observedCurrent.environmentRevisionId,
        compatibility,
        createdAt: compatibility.observedAt,
        boundAt: new Date().toISOString(),
      });
      activeBuild = compatible.build;
      gameRuntime = compatible.runtime;
      boundEnvironmentRevision = reusable.revision;
      boundAdapterRevision = reusable.adapterRevision;
      const reuseGoal = await runReusedProjectEnvironmentGoalV1({
        taskId,
        sessionId,
        bindingEpochId,
        turnId: asProjectEnvironmentTurnId(`turn.goal.${randomUUID()}`),
        goal: request.goal,
        budget: request.budget ?? DEFAULT_BUDGET,
        runTurn: (turn) => runTurn(turn),
        putTurn: (turn) => taskStore.appendTurn(turn).then(() => undefined),
      });
      ready = true;
      reused = true;
      goalDelivered = reuseGoal.goalDelivered;
      if (!goalDelivered && reuseGoal.turn !== null) {
        failureCode = reuseGoal.turn.terminalCode;
        failureMessage = reuseGoal.turn.terminalMessage;
      }
    }
    if (
      request.interactive === true &&
      ready &&
      validationCapabilitySet !== undefined &&
      boundEnvironmentRevision !== undefined &&
      boundAdapterRevision !== undefined
    ) {
      const tools = Object.freeze([
        ...createVNextCodingToolDefinitions(
          new SandboxPiCodingToolPort(broker),
        ),
        ...createProjectEnvironmentGameToolDefinitions(
          gameRuntime ??
            (() => {
              throw new Error(
                "Project Environment runtime was not composed after validation",
              );
            })(),
          validationCapabilitySet,
        ),
      ]);
      sessionFile = await runProjectEnvironmentInteractivePiSessionV1({
        resourceWorkspaceDirectory: layout.workspaceDirectory,
        sessionDirectory: layout.piSessionDirectory,
        ...(sessionFile === undefined ? {} : { sessionFile }),
        expectedSessionId: sessionId,
        provider: request.provider,
        model: request.model,
        thinkingLevel: request.thinkingLevel,
        tools,
        additionalEnvironmentInstructions: [
          "Project Environment binding:",
          `- taskId: ${taskId}`,
          `- environmentRevisionId: ${boundEnvironmentRevision.environmentRevisionId}`,
          `- adapterRevisionId: ${boundAdapterRevision.adapterRevisionId}`,
          `- compatibleBuildIdAtSessionEntry: ${activeBuild?.buildId ?? "unavailable"}`,
          "- Session switching is pinned to this Task and environment binding.",
          "- Game tools launch and retain one Task-owned instrumented Godot process at a time.",
          "- When no game runtime is active, game_capabilities freezes the current workspace and makes a new Build available only after exact compatibility smoke and durable receipts.",
          "- After editing source, call game_capabilities and launch the returned buildId; changed bytes are never silently assigned to a stale Build.",
        ].join("\n"),
        ...(request.agentDir === undefined
          ? {}
          : { agentDir: request.agentDir }),
      });
    }
  } catch (error) {
    recordPreviewFailure(error);
  } finally {
    try {
      await gameRuntime?.close();
    } catch (error) {
      recordPreviewFailure(error, "game_runtime_cleanup_failed");
    }
    try {
      const cleanup = await broker.cleanup();
      if (
        !cleanup.processGroupTerminated ||
        cleanup.cgroupPopulated ||
        !cleanup.scopeRemoved ||
        (sandbox.capability.taskStorage !== undefined &&
          cleanup.storageReconciled !== true)
      ) {
        throw Object.assign(
          new Error("Project Environment Task sandbox cleanup was incomplete"),
          { code: "sandbox_cleanup_incomplete" },
        );
      }
    } catch (error) {
      recordPreviewFailure(error, "sandbox_cleanup_failed");
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    status: ready && !previewFailed ? "ready" : "failed",
    taskId,
    sessionId,
    sessionFile: sessionFile ?? null,
    environmentId,
    environmentRevisionId:
      boundEnvironmentRevision?.environmentRevisionId ?? null,
    adapterRevisionId: boundAdapterRevision?.adapterRevisionId ?? null,
    buildId: activeBuild?.buildId ?? null,
    candidateSourceChanged:
      activeBuild !== undefined &&
      activeBuild.candidateSourceHash !== source.selectedTreeSha256,
    runtimeObservationReceiptId: runtimeObservationReceiptId ?? null,
    reused,
    goalDelivered,
    failureCode,
    failureMessage,
    taskDirectory: layout.taskRootDirectory,
    projectNamespace: project.namespaceRoot,
    provider: request.provider,
    model: request.model,
    thinkingLevel: request.thinkingLevel,
    limitations: Object.freeze([
      "PE-A Preview currently accepts only clean repository-root Godot 4.7.1 GDScript projects with one default launch target.",
      "A changed workspace becomes launchable only after game_capabilities or game_launch freezes the exact candidate Build and its Adapter compatibility smoke succeeds.",
      ...(securityEvents.length === 0
        ? []
        : [`${securityEvents.length} sandbox denial event(s) occurred.`]),
      ...additionalLimitations,
    ]),
  });
}
