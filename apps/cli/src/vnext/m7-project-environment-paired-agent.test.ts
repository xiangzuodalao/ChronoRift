import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1 } from "@chronorift/agent-protocol";
import {
  PROJECT_CAPABILITY_MODULE_NAMES_V1,
  ProjectAdapterRevisionV1Schema,
  asPatchId,
  asSha256DigestV1,
  asTaskId,
  type Sha256DigestV1,
} from "@chronorift/domain";
import type {
  ProjectEnvironmentGameToolPortRequestV1,
  RunVNextPiSdkTurnOptions,
} from "@chronorift/pi-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  SandboxExecutionOptionsV1,
  SandboxExecutionResultV1,
  TaskSandboxBrokerV1,
} from "./sandbox-broker.js";
import type { SandboxExecutionRequestV1 } from "./contracts.js";
import { collectCandidateGodotSourceV1 } from "./candidate-godot-build.js";
import {
  M7_NEUTRAL_ENVIRONMENT_INSTRUCTIONS_SHA256_V1,
  createM7CodingToolSurfaceV1,
  prepareM7ProjectEnvironmentPairedAgentPortV1,
  runM7ProjectEnvironmentPairedAgentV1,
  type M7PreparedCodeOnlyArmV1,
  type M7PreparedRuntimeArmV1,
} from "./m7-project-environment-paired-agent.js";
import {
  M7_NATURAL_USER_PROMPT_V1,
  M7PairedAgentArmResultV1Schema,
  createM7PairedAgentProtocolV1,
  createM7RuntimeResourceMapV1,
  runM7PairedAgentArmOnceV1,
  type M7AgentArmIsolationV1,
  type M7PairedAgentArmRequestV1,
  type M7PairedAgentInputV1,
} from "./m7-paired-agent.js";
import { selectedTreeSha256 } from "./selected-tree.js";
import type { ExtractTaskPatchRequest } from "./patch-handoff.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const digest = (value: string | Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));

const adapterRevision = ProjectAdapterRevisionV1Schema.parse({
  schemaVersion: 1,
  adapterRevisionId: "adapter-revision:m7:generic-patrol-v1",
  adapterId: "adapter:m7:generic-patrol",
  sourceId: `source:v1:${digest("pristine")}`,
  packageDigest: digest("generic adapter package"),
  manifestDigest: digest("generic adapter manifest"),
  implementationDigest: digest("generic adapter implementation"),
  payloadSchemaDigest: digest("generic adapter schemas"),
  sdkDigest: digest("sdk"),
  bridgeDigest: digest("bridge"),
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
  conformanceReceiptId: "conformance:m7:generic-patrol-v1",
  contentByteLength: 4096,
  contentFileCount: 4,
});

const executed = (
  request: SandboxExecutionRequestV1,
): SandboxExecutionResultV1 =>
  ({
    kind: "executed",
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    receipt: {
      operationId: request.operationId,
      requested: request,
      status: "succeeded",
      exitCode: 0,
    },
  }) as unknown as SandboxExecutionResultV1;

class WorkspaceBroker implements TaskSandboxBrokerV1 {
  public readonly executeCalls: SandboxExecutionRequestV1[] = [];
  public readonly executeOptionsCalls: (
    SandboxExecutionOptionsV1 | undefined
  )[] = [];
  public readonly cleanup = vi.fn(async () => {
    this.events.push(`cleanup:${this.arm}`);
    return {
      processGroupTerminated: true,
      cgroupPopulated: false,
      termSent: false,
      killSent: false,
      scopeRemoved: true,
      storageReconciled: true,
    };
  });

  public constructor(
    private readonly workspace: string,
    private readonly arm: "runtime_enabled" | "code_only",
    private readonly events: string[],
  ) {}

  public async execute(
    request: SandboxExecutionRequestV1,
    options?: SandboxExecutionOptionsV1,
  ): Promise<SandboxExecutionResultV1> {
    this.executeCalls.push(request);
    this.executeOptionsCalls.push(options);
    if (request.operationId.startsWith("m7-sentinel:")) {
      this.events.push(`sentinel:${this.arm}`);
    }
    if (
      request.argv[0] === "/bin/busybox" &&
      request.argv[1] === "sh" &&
      options?.stdin !== undefined
    ) {
      const target = request.argv.at(-1);
      if (target === undefined || !target.startsWith("/workspace/")) {
        throw new Error("unexpected sandbox write target");
      }
      await writeFile(
        join(this.workspace, target.slice("/workspace/".length)),
        options.stdin,
      );
    }
    return executed(request);
  }
}

const readableSurfaces = (runtime: boolean) => ({
  chronoriftGameTools: runtime,
  publicRuntimeRecordsThroughGameTools: runtime,
  projectAdapterPackage: false as const,
  rawGodotExecutable: false as const,
  hiddenAssignmentStore: false as const,
  hiddenMutationOrEvaluator: false as const,
  otherArmPatchOrRecords: false as const,
});

const patrolToolResponse = (toolCallId: string, taskId: string) => ({
  schemaVersion: 1 as const,
  toolCallId,
  outcome: "success" as const,
  output: {
    schemaVersion: 1 as const,
    taskId,
    executionId: "execution:m7:mutant-baseline",
    rows: [
      {
        schemaVersion: 1 as const,
        rowId: "row:m7:patrol:120",
        kind: "state" as const,
        clock: null,
        value: {
          schemaVersion: 1,
          stateDomainId: "patrol.motion",
          frame: 120,
          entities: [
            {
              entityId: "enemy-1",
              position: { x: 100, y: 82 },
              direction: 1,
              isOnFloor: false,
              leftRayColliding: false,
              rightRayColliding: false,
            },
          ],
        },
      },
    ],
    nextCursor: null,
    coverage: [],
    loss: [],
    limitations: [],
  },
});

interface PreparedTestCampaign {
  readonly pairedInput: M7PairedAgentInputV1;
  readonly runtimeArm: M7PreparedRuntimeArmV1;
  readonly codeOnlyArm: M7PreparedCodeOnlyArmV1;
  readonly runtimeBroker: WorkspaceBroker;
  readonly codeOnlyBroker: WorkspaceBroker;
  readonly runtimeClose: ReturnType<typeof vi.fn>;
  readonly readAgentEvidence: ReturnType<typeof vi.fn>;
  readonly gameInvoke: ReturnType<typeof vi.fn>;
  readonly runtimePatchPublish: ReturnType<typeof vi.fn>;
  readonly codeOnlyPatchPublish: ReturnType<typeof vi.fn>;
  readonly runtimeAgentStart: ReturnType<typeof vi.fn>;
  readonly codeOnlyAgentStart: ReturnType<typeof vi.fn>;
  readonly lifecycleEvents: string[];
}

const createWorkspace = async (root: string, arm: string) => {
  const workspace = join(root, `${arm}-workspace`);
  const session = join(root, `${arm}-session`);
  const cache = join(root, `${arm}-cache`);
  const baselineGit = join(root, `${arm}-baseline.git`);
  const hostTemporary = join(root, `${arm}-host-tmp`);
  await Promise.all([
    mkdir(join(workspace, "scripts"), { recursive: true }),
    mkdir(session),
    mkdir(cache),
    mkdir(baselineGit),
    mkdir(hostTemporary),
  ]);
  await Promise.all([
    writeFile(
      join(workspace, "project.godot"),
      '[application]\nrun/main_scene="res://main.tscn"\n',
    ),
    writeFile(
      join(workspace, "main.tscn"),
      '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n',
    ),
    writeFile(
      join(workspace, "scripts", "enemy.gd"),
      "extends Node\nvar speed := 20\n",
    ),
  ]);
  return { workspace, session, cache, baselineGit, hostTemporary };
};

const createCampaign = async (): Promise<PreparedTestCampaign> => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-m7-paired-pi-"));
  roots.push(root);
  const runtimePaths = await createWorkspace(root, "runtime");
  const codeOnlyPaths = await createWorkspace(root, "code-only");
  const baseline = selectedTreeSha256(
    await collectCandidateGodotSourceV1(
      runtimePaths.workspace,
      "project-environment",
      "tracked-tool-scripts-v1",
    ),
  );
  expect(
    selectedTreeSha256(
      await collectCandidateGodotSourceV1(
        codeOnlyPaths.workspace,
        "project-environment",
        "tracked-tool-scripts-v1",
      ),
    ),
  ).toBe(baseline);

  const lifecycleEvents: string[] = [];
  const runtimeBroker = new WorkspaceBroker(
    runtimePaths.workspace,
    "runtime_enabled",
    lifecycleEvents,
  );
  const codeOnlyBroker = new WorkspaceBroker(
    codeOnlyPaths.workspace,
    "code_only",
    lifecycleEvents,
  );
  const isolation = (
    arm: "runtime_enabled" | "code_only",
  ): M7AgentArmIsolationV1 => ({
    schemaVersion: 1,
    arm,
    taskId: `task:m7:${arm}`,
    workspaceHandle: `workspace:m7:${arm}`,
    workspaceInstanceSha256: digest(`${arm} workspace instance`),
    sessionInstanceSha256: digest(`${arm} Session instance`),
    cacheInstanceSha256: digest(`${arm} cache instance`),
    sandboxInstanceSha256: digest(`${arm} sandbox instance`),
    sandboxProfileSha256: digest("same coding sandbox policy"),
    workspaceBaselineSelectedTreeSha256: baseline,
    readableSurfaces: readableSurfaces(arm === "runtime_enabled"),
  });
  const runtimeIsolation = isolation("runtime_enabled");
  const codeOnlyIsolation = isolation("code_only");
  const pairedInput: M7PairedAgentInputV1 = {
    schemaVersion: 1,
    campaignId: "m7-campaign:0123456789abcdef01234567",
    publicTaskSpecSha256: digest("natural public task"),
    runtimeArmPublicTaskSpecSha256: digest("runtime bootstrap task"),
    codeOnlyArmPublicTaskSpecSha256: digest("code-only bootstrap task"),
    prompt: M7_NATURAL_USER_PROMPT_V1,
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    thinkingLevel: "max",
    agentBudget: {
      schemaVersion: 1,
      attemptsMaximum: 1,
      userTurnsPerAttemptMaximum: 1,
      toolCallsMaximum: 64,
      wallTimeMsMaximum: 900_000,
      taskSandboxNetworkMode: "denied",
      taskCredentialMountCountMaximum: 0,
    },
    baselineSelectedTreeSha256: baseline,
    commonEnvironmentInstructionsSha256:
      M7_NEUTRAL_ENVIRONMENT_INSTRUCTIONS_SHA256_V1,
    hostModelRuntimeConfigSha256: digest("shared Host model runtime config"),
    codingTools: [...createM7CodingToolSurfaceV1(runtimeBroker)],
    sensorFreezeRecordSha256: digest("sensor freeze"),
    pristineAdapterRevision: adapterRevision,
    hostAdmittedGameToolNames: [
      PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.capabilities,
      PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.query,
    ],
    runtimeResourceMap: createM7RuntimeResourceMapV1({
      schemaVersion: 1,
      taskId: runtimeIsolation.taskId,
      baselineBuildId: "build:m7:mutant-baseline",
      baselineSourceId: "source:m7:mutant-baseline",
      launchTargetId: "launch:m7:default",
    }),
    runtimeIsolation,
    codeOnlyIsolation,
  };
  const runtimeClose = vi.fn(async () => undefined);
  const readAgentEvidence = vi.fn(async () => ({
    sourceObservations: [],
    executions: [],
    runtimeUseSummaries: [],
    receiptSha256: digest("runtime Agent evidence"),
  }));
  const gameInvoke = vi.fn(
    async (request: ProjectEnvironmentGameToolPortRequestV1) =>
      request.toolName === PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.query
        ? patrolToolResponse(request.toolCallId, runtimeIsolation.taskId)
        : {
            schemaVersion: 1 as const,
            toolCallId: request.toolCallId,
            outcome: "error" as const,
            error: {
              code: "runtime_unavailable" as const,
              message: "test observation only",
              recoverable: true,
            },
          },
  );
  const runtimePatchPublish = vi.fn();
  const codeOnlyPatchPublish = vi.fn();
  const runtimeAgentStart = vi.fn(() =>
    lifecycleEvents.push("agent-start:runtime_enabled"),
  );
  const codeOnlyAgentStart = vi.fn(() =>
    lifecycleEvents.push("agent-start:code_only"),
  );
  const common = (
    arm: "runtime_enabled" | "code_only",
    paths: typeof runtimePaths,
    broker: WorkspaceBroker,
    armIsolation: M7AgentArmIsolationV1,
    patchPublish: typeof runtimePatchPublish,
  ) => ({
    arm,
    isolation: armIsolation,
    workspaceDirectory: paths.workspace,
    sessionDirectory: paths.session,
    agentResourceDirectory: paths.cache,
    broker,
    codingSandboxSentinelForbiddenPaths: [
      "/opt/chronorift/runtime/godot",
      "/host-only/m7",
    ],
    patchHandoff: {
      hostBaselineGitDirectory: paths.baselineGit,
      hostBaselineCommit: "1".repeat(40),
      hostOperationTemporaryDirectory: paths.hostTemporary,
      ignoredCachePaths: [],
      patchStore: { publishOnce: patchPublish },
    },
    now: () => "2026-08-15T00:00:00.000Z",
    persistCleanupReceiptOnce: vi.fn(async (record) =>
      digest(JSON.stringify(record)),
    ),
    persistSandboxSentinelReceiptOnce: vi.fn(async (record) =>
      digest(JSON.stringify(record)),
    ),
    markAgentStartedOnce:
      arm === "runtime_enabled" ? runtimeAgentStart : codeOnlyAgentStart,
  });
  const runtimeArm: M7PreparedRuntimeArmV1 = {
    ...common(
      "runtime_enabled",
      runtimePaths,
      runtimeBroker,
      runtimeIsolation,
      runtimePatchPublish,
    ),
    arm: "runtime_enabled",
    runtime: {
      pristineAdapterRevision: adapterRevision,
      resourceMap: pairedInput.runtimeResourceMap,
      gameToolPort: { invoke: gameInvoke },
      close: runtimeClose,
      readAgentEvidence,
    },
  };
  const codeOnlyArm: M7PreparedCodeOnlyArmV1 = {
    ...common(
      "code_only",
      codeOnlyPaths,
      codeOnlyBroker,
      codeOnlyIsolation,
      codeOnlyPatchPublish,
    ),
    arm: "code_only",
  };
  return {
    pairedInput,
    runtimeArm,
    codeOnlyArm,
    runtimeBroker,
    codeOnlyBroker,
    runtimeClose,
    readAgentEvidence,
    gameInvoke,
    runtimePatchPublish,
    codeOnlyPatchPublish,
    runtimeAgentStart,
    codeOnlyAgentStart,
    lifecycleEvents,
  };
};

const piResult = (request: RunVNextPiSdkTurnOptions, ordinal: number) => ({
  schemaVersion: 1 as const,
  status: "completed" as const,
  sessionId: request.newSessionId ?? `session:m7:${ordinal}`,
  sessionFile: join(request.sessionDirectory, "session.jsonl"),
  provider: request.provider,
  model: request.model,
  requestedThinkingLevel: request.thinkingLevel,
  realizedThinkingLevel: request.thinkingLevel,
  activeTools: request.tools.map((tool) => tool.name),
  assistantText: "Candidate left for review.",
  errorMessage: null,
  eventsObserved: 1,
  observedTurnCount: 1 as const,
  stats: {
    sessionFile: join(request.sessionDirectory, "session.jsonl"),
    sessionId: request.newSessionId ?? `session:m7:${ordinal}`,
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 1,
    toolResults: 1,
    totalMessages: 3,
    tokens: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      total: 2,
    },
    cost: 0,
  },
});

describe("M7 production paired Pi/sandbox composition", () => {
  it("runs two fresh Sessions with the same natural prompt and only runtime-arm game tools", async () => {
    const campaign = await createCampaign();
    const requests: RunVNextPiSdkTurnOptions[] = [];
    const runPiTurn = vi.fn(async (request: RunVNextPiSdkTurnOptions) => {
      requests.push(request);
      campaign.lifecycleEvents.push(
        `pi:${requests.length === 1 ? "runtime_enabled" : "code_only"}`,
      );
      const capabilities = request.tools.find(
        (tool) =>
          tool.name === PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.capabilities,
      );
      if (capabilities !== undefined) {
        await capabilities.execute(
          "m7-test-capabilities",
          {
            schemaVersion: 1,
            taskId: campaign.runtimeArm.isolation.taskId,
          },
          undefined,
          undefined,
          {} as never,
        );
      }
      return piResult(request, requests.length);
    });

    const result = await runM7ProjectEnvironmentPairedAgentV1(campaign, {
      runPiTurn,
    });

    expect(result.status).toBe("both_arms_recorded");
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.prompt)).toEqual([
      M7_NATURAL_USER_PROMPT_V1,
      M7_NATURAL_USER_PROMPT_V1,
    ]);
    expect(
      requests.every((request) => request.resumeSessionFile === undefined),
    ).toBe(true);
    expect(requests[0]?.newSessionId).not.toBe(requests[1]?.newSessionId);
    expect(requests[0]?.sessionDirectory).not.toBe(
      requests[1]?.sessionDirectory,
    );
    expect(requests[0]?.agentDir).not.toBe(requests[1]?.agentDir);
    expect(requests[0]?.additionalEnvironmentInstructions).toContain(
      "runtime resource map (identifiers only)",
    );
    expect(requests[0]?.additionalEnvironmentInstructions).not.toMatch(
      /reproduce|verify|before (?:editing|modifying)|rerun/iu,
    );
    expect(requests[1]?.additionalEnvironmentInstructions).toBeUndefined();
    expect(
      requests.every((request) => request.loadProjectAdapterSkillV1 === false),
    ).toBe(true);
    const runtimeTools = requests[0]?.tools.map((tool) => tool.name) ?? [];
    const codeOnlyTools = requests[1]?.tools.map((tool) => tool.name) ?? [];
    expect(runtimeTools).toEqual([
      ...codeOnlyTools,
      PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.capabilities,
      PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.query,
    ]);
    expect(codeOnlyTools.some((name) => name.startsWith("game_"))).toBe(false);
    expect(campaign.gameInvoke).toHaveBeenCalledTimes(1);
    expect(campaign.readAgentEvidence).toHaveBeenCalledTimes(1);
    expect(campaign.readAgentEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        exchanges: [
          expect.objectContaining({
            toolName: PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.capabilities,
          }),
        ],
      }),
    );
    expect(result.runtimeArm.result?.runtimeEvidenceReceiptSha256).toBe(
      digest("runtime Agent evidence"),
    );
    expect(result.runtimeArm.attemptEvidence).toMatchObject({
      terminalStage: "sealed",
      terminalCode: "completed",
      piTurnStarted: true,
      piResultObserved: true,
      piStats: {
        eventsObserved: 1,
        userMessages: 1,
        toolCalls: 1,
        totalTokens: 2,
      },
      runtimeEvidenceReceiptSha256: digest("runtime Agent evidence"),
      cleanup: {
        runtimeCloseRequired: true,
        runtimeCloseAttempted: true,
        runtimeCloseCompleted: true,
        sandboxCleanupAttempted: true,
        sandboxCleanupReceiptObserved: true,
        processGroupTerminated: true,
        cgroupPopulated: false,
        scopeRemoved: true,
        storageReconciliationObserved: true,
        storageReconciled: true,
        cleanupResultValid: true,
        cleanupProven: true,
        cleanupInfrastructureFailure: false,
      },
    });
    expect(result.codeOnlyArm?.result?.runtimeEvidenceReceiptSha256).toBeNull();
    expect(campaign.runtimeClose).toHaveBeenCalledTimes(1);
    expect(campaign.runtimeBroker.cleanup).toHaveBeenCalledTimes(1);
    expect(campaign.codeOnlyBroker.cleanup).toHaveBeenCalledTimes(1);
    expect(campaign.lifecycleEvents).toEqual([
      "sentinel:runtime_enabled",
      "agent-start:runtime_enabled",
      "pi:runtime_enabled",
      "cleanup:runtime_enabled",
      "sentinel:code_only",
      "agent-start:code_only",
      "pi:code_only",
      "cleanup:code_only",
    ]);
    const runtimeSentinel = campaign.runtimeBroker.executeCalls[0];
    const runtimeSentinelOptions =
      campaign.runtimeBroker.executeOptionsCalls[0];
    expect(runtimeSentinel?.argv).not.toContain(
      "/opt/chronorift/runtime/godot",
    );
    expect(runtimeSentinel?.argv).not.toContain("/host-only/m7");
    expect(
      Buffer.from(runtimeSentinelOptions?.stdin ?? []).toString("utf8"),
    ).toBe("/opt/chronorift/runtime/godot\0/host-only/m7\0");
  });

  it("exposes one-shot pre-Agent sentinels without starting Pi", async () => {
    const campaign = await createCampaign();
    const runPiTurn = vi.fn();
    const port = await prepareM7ProjectEnvironmentPairedAgentPortV1(campaign, {
      runPiTurn,
    });

    const runtimeSentinel =
      await port.runPreAgentSandboxSentinelOnce("runtime_enabled");
    await campaign.runtimeArm.runtime.close();
    await campaign.runtimeBroker.cleanup();
    const codeOnlySentinel =
      await port.runPreAgentSandboxSentinelOnce("code_only");
    await campaign.codeOnlyBroker.cleanup();

    expect(runtimeSentinel).toMatch(/^[a-f0-9]{64}$/u);
    expect(codeOnlySentinel).toMatch(/^[a-f0-9]{64}$/u);
    expect(campaign.lifecycleEvents).toEqual([
      "sentinel:runtime_enabled",
      "cleanup:runtime_enabled",
      "sentinel:code_only",
      "cleanup:code_only",
    ]);
    expect(runPiTurn).not.toHaveBeenCalled();
    expect(campaign.runtimeAgentStart).not.toHaveBeenCalled();
    expect(campaign.codeOnlyAgentStart).not.toHaveBeenCalled();
    expect(campaign.runtimeClose).toHaveBeenCalledTimes(1);
    await expect(
      port.runPreAgentSandboxSentinelOnce("runtime_enabled"),
    ).rejects.toThrow(/only once/iu);
    await expect(
      port.runArm({ arm: "runtime_enabled" } as never),
    ).rejects.toThrow(/after the pre-Agent dry-run/iu);
    await expect(
      port.cleanupArm({ arm: "runtime_enabled" } as never),
    ).rejects.toThrow(/attempt-bound cleanup/iu);
  });

  it("records a coding-tool source boundary and freezes an admissible round-trip patch", async () => {
    const campaign = await createCampaign();
    const patchBytes = Buffer.from(
      "diff --git a/scripts/enemy.gd b/scripts/enemy.gd\n",
    );
    const patchSha256 = digest(patchBytes);
    campaign.runtimePatchPublish.mockResolvedValue({
      schemaVersion: 1,
      artifactId: `m6-artifact:${patchSha256}`,
      rawSha256: patchSha256,
      byteLength: patchBytes.byteLength,
    });
    const extractPatch = vi.fn(async (request: ExtractTaskPatchRequest) => ({
      identity: {
        schemaVersion: 1 as const,
        patchId: asPatchId(`patch:v1:${patchSha256}`),
        taskId: asTaskId(request.taskId),
        baselineSourceHash: request.baselineSourceHash,
        candidateSourceHash: selectedTreeSha256(
          await collectCandidateGodotSourceV1(
            request.workspaceDirectory,
            "project-environment",
            "tracked-tool-scripts-v1",
          ),
        ),
        patchHash: patchSha256,
        byteLength: patchBytes.byteLength,
      },
      patchBytes,
      roundTripVerified: true as const,
    }));
    const requests: RunVNextPiSdkTurnOptions[] = [];
    const runPiTurn = vi.fn(async (request: RunVNextPiSdkTurnOptions) => {
      requests.push(request);
      if (requests.length === 1) {
        const write = request.tools.find((tool) => tool.name === "write");
        if (write === undefined) throw new Error("write tool missing");
        await write.execute(
          "m7-test-write",
          {
            path: "scripts/enemy.gd",
            content: "extends Node\nvar speed := 21\n",
          },
          undefined,
          undefined,
          {} as never,
        );
      }
      return piResult(request, requests.length);
    });

    const result = await runM7ProjectEnvironmentPairedAgentV1(campaign, {
      runPiTurn,
      extractPatch: extractPatch as never,
    });

    expect(result.status).toBe("both_arms_recorded");
    expect(result.runtimeArm.result?.candidatePatch).toMatchObject({
      admissible: true,
      roundTripVerified: true,
      patchIdentity: {
        baselineSelectedTreeSha256:
          campaign.pairedInput.baselineSelectedTreeSha256,
        patchSha256,
      },
    });
    expect(
      result.runtimeArm.result?.sourceObservations.map(
        (observation) => observation.boundary,
      ),
    ).toEqual([
      "initial_materialization",
      "coding_tool_return",
      "patch_freeze",
    ]);
    expect(extractPatch).toHaveBeenCalledTimes(1);
    expect(campaign.runtimePatchPublish).toHaveBeenCalledWith(patchBytes);
    expect(campaign.codeOnlyPatchPublish).not.toHaveBeenCalled();
  });

  it("retains exact partial Agent-visible runtime evidence when candidate handoff throws", async () => {
    const campaign = await createCampaign();
    const secret = "TOP_SECRET_MODEL_PROSE";
    const privateSessionPath = "/host/private/pi/session.jsonl";
    const runPiTurn = vi.fn(async (request: RunVNextPiSdkTurnOptions) => {
      const query = request.tools.find((tool) => tool.name === "game_query");
      const write = request.tools.find((tool) => tool.name === "write");
      if (query === undefined || write === undefined) {
        throw new Error("required test tools missing");
      }
      await query.execute(
        "m7-partial-patrol-query",
        {
          schemaVersion: 1,
          taskId: campaign.runtimeArm.isolation.taskId,
          executionId: "execution:m7:mutant-baseline",
          select: "state",
          limit: 10,
        },
        undefined,
        undefined,
        {} as never,
      );
      await write.execute(
        "m7-partial-write",
        {
          path: "scripts/enemy.gd",
          content: "extends Node\nvar speed := 99\n",
        },
        undefined,
        undefined,
        {} as never,
      );
      const result = piResult(request, 1);
      return {
        ...result,
        sessionId: `session:${secret}`,
        sessionFile: privateSessionPath,
        assistantText: secret,
        errorMessage: `do-not-retain-${secret}`,
        stats: {
          ...result.stats,
          sessionId: `session:${secret}`,
          sessionFile: privateSessionPath,
        },
      };
    });
    const extractPatch = vi.fn(async () => {
      throw new Error(
        `candidate handoff failed ${secret} ${privateSessionPath}`,
      );
    });

    const result = await runM7ProjectEnvironmentPairedAgentV1(campaign, {
      runPiTurn: runPiTurn as never,
      extractPatch: extractPatch as never,
    });

    expect(result.status).toBe("runtime_infrastructure_failure");
    expect(result.codeOnlyArm).toBeNull();
    expect(result.runtimeArm.infrastructureFailureCode).toBe("runner_threw");
    expect(result.runtimeArm.attemptEvidence).toMatchObject({
      terminalStage: "candidate_patch_handoff",
      terminalCode: "operation_threw",
      piTurnStarted: true,
      piResultObserved: true,
      piStats: {
        eventsObserved: 1,
        userMessages: 1,
        toolCalls: 1,
        totalTokens: 2,
      },
      runtimeEvidenceReceiptSha256: digest("runtime Agent evidence"),
      cleanup: {
        runtimeCloseCompleted: true,
        sandboxCleanupReceiptObserved: true,
        processGroupTerminated: true,
        cgroupPopulated: false,
        scopeRemoved: true,
        storageReconciled: true,
        cleanupProven: true,
      },
    });
    const [exchange] =
      result.runtimeArm.attemptEvidence.agentVisibleGameToolExchanges;
    expect(exchange).toMatchObject({
      ordinal: 1,
      hostToolReturnOrdinal: 1,
      toolName: PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.query,
    });
    expect(exchange?.response).toEqual(
      patrolToolResponse(
        "m7-partial-patrol-query",
        campaign.runtimeArm.isolation.taskId,
      ),
    );
    expect(exchange?.inputSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(exchange?.responseSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(exchange?.exchangeSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      result.runtimeArm.attemptEvidence.sourceObservations.map(
        (observation) => observation.boundary,
      ),
    ).toEqual(["initial_materialization", "coding_tool_return"]);
    const retained = JSON.stringify(result.runtimeArm.attemptEvidence);
    expect(retained).not.toContain(secret);
    expect(retained).not.toContain(privateSessionPath);
    expect(retained).not.toContain("candidate handoff failed");
    expect(retained).not.toMatch(
      /assistantText|errorMessage|sessionId|sessionFile/u,
    );
    expect(extractPatch).toHaveBeenCalledTimes(1);
  });

  it("retains the exact patrol response when the otherwise completed arm result is invalid", async () => {
    const campaign = await createCampaign();
    const secret = "INVALID_RESULT_ASSISTANT_SECRET";
    const privateSessionPath = "/host/private/invalid/session.jsonl";
    const runPiTurn = vi.fn(async (request: RunVNextPiSdkTurnOptions) => {
      const query = request.tools.find((tool) => tool.name === "game_query");
      if (query === undefined) throw new Error("query tool missing");
      await query.execute(
        "m7-exact-patrol-query",
        {
          schemaVersion: 1,
          taskId: campaign.runtimeArm.isolation.taskId,
          executionId: "execution:m7:mutant-baseline",
          select: "state",
          limit: 10,
        },
        undefined,
        undefined,
        {} as never,
      );
      const result = piResult(request, 1);
      return {
        ...result,
        sessionId: `session:${secret}`,
        sessionFile: privateSessionPath,
        assistantText: secret,
        errorMessage: `do-not-retain-${secret}`,
        stats: {
          ...result.stats,
          sessionId: `session:${secret}`,
          sessionFile: privateSessionPath,
        },
      };
    });
    const preparedPort = await prepareM7ProjectEnvironmentPairedAgentPortV1(
      campaign,
      {
        runPiTurn: runPiTurn as never,
      },
    );
    const protocol = createM7PairedAgentProtocolV1(campaign.pairedInput);
    const attempt = await runM7PairedAgentArmOnceV1({
      request: protocol.runtimeRequest,
      port: {
        runArm: async (request: M7PairedAgentArmRequestV1) => ({
          ...M7PairedAgentArmResultV1Schema.parse(
            await preparedPort.runArm(request),
          ),
          realizedModel: "invalid-model-binding",
        }),
        cleanupArm: (request) => preparedPort.cleanupArm(request),
        sealAttemptEvidenceOnce: (request) => {
          if (preparedPort.sealAttemptEvidenceOnce === undefined) {
            throw new Error("prepared evidence seal missing");
          }
          return preparedPort.sealAttemptEvidenceOnce(request);
        },
      },
    });

    expect(attempt.infrastructureFailureCode).toBe("runner_result_invalid");
    expect(attempt.result).toBeNull();
    expect(attempt.attemptEvidence).toMatchObject({
      terminalStage: "arm_result_validation",
      terminalCode: "result_invalid",
      piResultObserved: true,
      runtimeEvidenceReceiptSha256: digest("runtime Agent evidence"),
      cleanup: { cleanupProven: true },
    });
    const [exchange] = attempt.attemptEvidence.agentVisibleGameToolExchanges;
    expect(exchange?.response).toEqual(
      patrolToolResponse(
        "m7-exact-patrol-query",
        campaign.runtimeArm.isolation.taskId,
      ),
    );
    expect(exchange?.responseSha256).toMatch(/^[a-f0-9]{64}$/u);
    const retained = JSON.stringify(attempt.attemptEvidence);
    expect(retained).not.toContain(secret);
    expect(retained).not.toContain(privateSessionPath);
    expect(retained).not.toMatch(
      /assistantText|errorMessage|sessionId|sessionFile/u,
    );
  });

  it("does not manufacture runtime evidence when the Agent makes no game-tool call", async () => {
    const campaign = await createCampaign();
    const runPiTurn = vi.fn(async (request: RunVNextPiSdkTurnOptions) =>
      piResult(request, request.tools.length),
    );

    const result = await runM7ProjectEnvironmentPairedAgentV1(campaign, {
      runPiTurn,
    });

    expect(result.status).toBe("both_arms_recorded");
    expect(campaign.gameInvoke).not.toHaveBeenCalled();
    expect(campaign.readAgentEvidence).not.toHaveBeenCalled();
    expect(result.runtimeArm.result?.executions).toEqual([]);
    expect(result.runtimeArm.result?.runtimeEvidenceReceiptSha256).toBeNull();
  });

  it("does not call a rejected runtime-port response Agent-visible evidence", async () => {
    const campaign = await createCampaign();
    campaign.gameInvoke.mockResolvedValueOnce({
      schemaVersion: 1,
      toolCallId: "different-tool-call",
      outcome: "success",
      output: {
        taskId: campaign.runtimeArm.isolation.taskId,
        executionId: "execution:m7:not-delivered",
        rows: [
          {
            kind: "state_sample",
            payload: { stateDomainId: "patrol.motion" },
          },
        ],
      },
    } as never);
    const runPiTurn = vi.fn(async (request: RunVNextPiSdkTurnOptions) => {
      const query = request.tools.find((tool) => tool.name === "game_query");
      if (query !== undefined) {
        await expect(
          query.execute(
            "m7-query-result-that-must-not-be-recorded",
            {
              schemaVersion: 1,
              taskId: campaign.runtimeArm.isolation.taskId,
              executionId: "execution:m7:not-delivered",
              select: "state",
              limit: 10,
            },
            undefined,
            undefined,
            {} as never,
          ),
        ).rejects.toThrow(/toolCallId/iu);
      }
      return piResult(request, request.tools.length);
    });

    const result = await runM7ProjectEnvironmentPairedAgentV1(campaign, {
      runPiTurn,
    });

    expect(result.status).toBe("both_arms_recorded");
    expect(campaign.gameInvoke).toHaveBeenCalledTimes(1);
    expect(campaign.readAgentEvidence).not.toHaveBeenCalled();
    expect(result.runtimeArm.result?.runtimeUseSummaries).toEqual([]);
    expect(result.runtimeArm.result?.runtimeEvidenceReceiptSha256).toBeNull();
  });

  it("rejects reused Session/cache resources before the first Pi call", async () => {
    const campaign = await createCampaign();
    const runPiTurn = vi.fn();
    const invalid: PreparedTestCampaign = {
      ...campaign,
      codeOnlyArm: {
        ...campaign.codeOnlyArm,
        sessionDirectory: campaign.runtimeArm.sessionDirectory,
      },
    };

    await expect(
      runM7ProjectEnvironmentPairedAgentV1(invalid, { runPiTurn }),
    ).rejects.toThrow(/disjoint/iu);
    expect(runPiTurn).not.toHaveBeenCalled();
  });
});
