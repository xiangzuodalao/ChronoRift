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
import { afterEach, describe, expect, it, vi } from "vitest";

import { collectCandidateGodotSourceV1 } from "./candidate-godot-build.js";
import { checkExternalHiddenFixWorkflowV1 } from "./external-hidden-fix-workflow.js";
import {
  createM6AdmittedGameToolsV1,
  runM6OneTurnAgentV1,
  type M6OneTurnAgentPortV1,
  type M6OneTurnAgentRequestV1,
} from "./m6-one-turn-agent.js";
import { prepareM6ExactGodotBuildV1 } from "./m6-exact-godot-build.js";
import { selectedTreeSha256 } from "./selected-tree.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const sha = (value: string) =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));

const adapterRevision = ProjectAdapterRevisionV1Schema.parse({
  schemaVersion: 1,
  adapterRevisionId: "adapter-revision:m6:pristine",
  adapterId: "adapter:m6:task-blind",
  sourceId: `source:${sha("pristine project")}`,
  packageDigest: sha("adapter package"),
  manifestDigest: sha("adapter manifest"),
  implementationDigest: sha("adapter implementation"),
  payloadSchemaDigest: sha("adapter payload schemas"),
  sdkDigest: sha("managed sdk"),
  bridgeDigest: sha("managed bridge"),
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
    receiptId: `m6-compatibility:${lineage.buildRole}`,
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
    observedAt:
      lineage.buildRole === "assignment_baseline"
        ? "2026-08-14T00:00:02.100Z"
        : "2026-08-14T00:00:04.100Z",
  });

const createProject = async (): Promise<{
  readonly workspace: string;
  readonly baselineHash: ReturnType<typeof sha>;
}> => {
  const workspace = await mkdtemp(join(tmpdir(), "chronorift-m6-turn-"));
  roots.push(workspace);
  await mkdir(join(workspace, "scripts"));
  await writeFile(
    join(workspace, "project.godot"),
    '[application]\nrun/main_scene="res://main.tscn"\n',
  );
  await writeFile(
    join(workspace, "main.tscn"),
    '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n',
  );
  await writeFile(
    join(workspace, "scripts", "player.gd"),
    "extends Node\nvar jump_speed := 10\n",
  );
  const entries = await collectCandidateGodotSourceV1(
    workspace,
    "project-environment",
    "tracked-tool-scripts-v1",
  );
  return { workspace, baselineHash: selectedTreeSha256(entries) };
};

const clock = () => {
  const values = [0, 1, 2, 3, 4, 5].map(
    (seconds) => `2026-08-14T00:00:0${seconds}.000Z`,
  );
  return () => {
    const value = values.shift();
    if (value === undefined) throw new Error("test clock exhausted");
    return value;
  };
};

const request = (
  workspaceDirectory: string,
  baselineSourceHash: ReturnType<typeof sha>,
): M6OneTurnAgentRequestV1 => ({
  assignmentId: "m6-assignment:0123456789abcdef01234567",
  taskId: asTaskId("task:m6:external-hidden-fix"),
  workspaceId: asWorkspaceId("workspace:m6:external-hidden-fix"),
  workspaceDirectory,
  baselineSourceHash,
  pristineAdapterRevision: adapterRevision,
  toolchainReceiptId: "toolchain:m6:godot-4.7.1",
  toolchainArtifactDigest: sha("godot executable"),
  runtimeIdentity: {
    schemaVersion: 1,
    managedRuntimeId: "managed-runtime:m6:godot-4.7.1",
    engineVersion: "4.7.1",
    runtimeArtifactDigest: sha("managed runtime"),
    overlayDigest: sha("managed overlay"),
  },
  policyProfileDigest: sha("sandbox policy"),
  hostCodingToolNames: ["read", "write", "bash"],
  hostAdmittedGameToolNames: [
    PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.capabilities,
    PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.query,
  ],
  prompt: "Investigate the runtime bug, edit the source, and rerun it.",
  now: clock(),
});

const createPort = (
  workspace: string,
  baselineHash: ReturnType<typeof sha>,
  options: {
    readonly agentStatus?:
      "completed" | "provider_failure" | "timed_out" | "aborted";
    readonly earlyChangedObservation?: boolean;
    readonly omitBaselineExecution?: boolean;
    readonly omitCandidateExecution?: boolean;
    readonly patchReferenceMismatch?: "sha256" | "byte_length";
  } = {},
) => {
  const runCompatibility = vi.fn(
    async (input: Parameters<M6OneTurnAgentPortV1["runCompatibility"]>[0]) =>
      compatibilityReceipt(input.lineage),
  );
  const runAgentTurn = vi.fn(
    async (input: Parameters<M6OneTurnAgentPortV1["runAgentTurn"]>[0]) => {
      const status = options.agentStatus ?? "completed";
      if (status !== "completed") {
        return {
          schemaVersion: 1 as const,
          status,
          activeToolNames: [
            ...input.codingToolNames,
            ...input.gameTools.map((tool) => tool.name),
          ],
          sourceObservations: [],
          executions: [],
        };
      }
      const baselineExecution = {
        schemaVersion: 1 as const,
        executionId: "execution:m6:agent-baseline",
        buildId: input.baselineBuild.buildId,
        sourceSha256: input.baselineBuild.sourceHash,
        startedAt: "2026-08-14T00:00:02.200Z",
        endedAt: "2026-08-14T00:00:02.500Z",
        sealed: true,
        coverageComplete: true,
        cleanupProven: true,
        publicSymptomObserved: true,
        publicObservationSha256: sha("agent baseline observation"),
      };
      await writeFile(
        join(workspace, "scripts", "player.gd"),
        "extends Node\nvar jump_speed := 20\n",
      );
      const candidate = await prepareM6ExactGodotBuildV1({
        taskId: input.baselineBuild.taskId,
        workspaceId: input.baselineBuild.workspaceId,
        workspaceDirectory: workspace,
        baselineSourceHash: baselineHash,
        adapterRevision,
        toolchainReceiptId: "toolchain:m6:godot-4.7.1",
        toolchainArtifactDigest: sha("godot executable"),
        runtimeIdentity: {
          schemaVersion: 1,
          managedRuntimeId: "managed-runtime:m6:godot-4.7.1",
          engineVersion: "4.7.1",
          runtimeArtifactDigest: sha("managed runtime"),
          overlayDigest: sha("managed overlay"),
        },
        policyProfileDigest: sha("sandbox policy"),
        now: "2026-08-14T00:00:03.000Z",
      });
      const candidateExecution = {
        schemaVersion: 1 as const,
        executionId: "execution:m6:agent-candidate",
        buildId: candidate.build.buildId,
        sourceSha256: candidate.build.sourceHash,
        startedAt: "2026-08-14T00:00:03.100Z",
        endedAt: "2026-08-14T00:00:03.500Z",
        sealed: true,
        coverageComplete: true,
        cleanupProven: true,
        publicSymptomObserved: false,
        publicObservationSha256: sha("agent candidate observation"),
      };
      return {
        schemaVersion: 1 as const,
        status,
        activeToolNames: [
          ...input.codingToolNames,
          ...input.gameTools.map((tool) => tool.name),
        ],
        sourceObservations:
          options.earlyChangedObservation === true
            ? [
                {
                  schemaVersion: 1 as const,
                  boundary: "coding_tool_return" as const,
                  sourceSha256: sha("transient changed source"),
                  buildId: null,
                  observedAt: "2026-08-14T00:00:02.400Z",
                },
                {
                  schemaVersion: 1 as const,
                  boundary: "game_build_freeze" as const,
                  sourceSha256: candidate.build.sourceHash,
                  buildId: candidate.build.buildId,
                  observedAt: "2026-08-14T00:00:03.000Z",
                },
              ]
            : [
                {
                  schemaVersion: 1 as const,
                  boundary: "game_build_freeze" as const,
                  sourceSha256: candidate.build.sourceHash,
                  buildId: candidate.build.buildId,
                  observedAt: "2026-08-14T00:00:03.000Z",
                },
              ],
        executions: [
          ...(options.omitBaselineExecution === true
            ? []
            : [baselineExecution]),
          ...(options.omitCandidateExecution === true
            ? []
            : [candidateExecution]),
        ],
      };
    },
  );
  const freezePatch = vi.fn(
    async (input: Parameters<M6OneTurnAgentPortV1["freezePatch"]>[0]) => ({
      patch: {
        schemaVersion: 1 as const,
        artifactId: `m6-artifact:${"a".repeat(64)}`,
        rawSha256:
          options.patchReferenceMismatch === "sha256"
            ? sha("different patch bytes")
            : sha("frozen patch"),
        byteLength:
          options.patchReferenceMismatch === "byte_length" ? 129 : 128,
      },
      patchIdentity: {
        schemaVersion: 1 as const,
        baselineSelectedTreeSha256: input.baselineBuild.sourceHash,
        candidateSelectedTreeSha256: input.candidateBuild.sourceHash,
        patchSha256: sha("frozen patch"),
        byteLength: 128,
      },
      admissible: true,
      roundTripVerified: true,
    }),
  );
  const cleanupTask = vi.fn(async () => ({
    proven: true,
    receiptSha256: sha("M6 task cleanup receipt"),
  }));
  const port: M6OneTurnAgentPortV1 = {
    runCompatibility,
    runAgentTurn,
    freezePatch,
    cleanupTask,
  };
  return {
    port,
    runCompatibility,
    runAgentTurn,
    freezePatch,
    cleanupTask,
  };
};

describe("M6 one-turn Agent orchestration", () => {
  it("runs exactly one Agent turn and returns exact public baseline/candidate workflow evidence", async () => {
    const project = await createProject();
    const fixture = createPort(project.workspace, project.baselineHash);
    const result = await runM6OneTurnAgentV1(
      request(project.workspace, project.baselineHash),
      fixture.port,
    );

    expect(result.status).toBe("workflow_ready");
    if (result.status !== "workflow_ready") {
      throw new Error("expected a frozen candidate");
    }
    expect(fixture.runAgentTurn).toHaveBeenCalledTimes(1);
    expect(fixture.runCompatibility).toHaveBeenCalledTimes(2);
    expect(fixture.freezePatch).toHaveBeenCalledTimes(1);
    expect(fixture.cleanupTask).toHaveBeenCalledTimes(1);
    expect(fixture.runCompatibility.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.runAgentTurn.mock.invocationCallOrder[0] ?? 0,
    );
    expect(fixture.runAgentTurn.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.runCompatibility.mock.invocationCallOrder[1] ?? 0,
    );
    expect(result.admittedGameTools.map((tool) => tool.name)).toEqual([
      PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.capabilities,
      PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.query,
    ]);

    const currentTree = selectedTreeSha256(
      await collectCandidateGodotSourceV1(
        project.workspace,
        "project-environment",
        "tracked-tool-scripts-v1",
      ),
    );
    expect(result.candidate.build.sourceHash).toBe(currentTree);
    expect(result.candidate.build.sourceId).toBe(`source:${currentTree}`);
    expect(result.baseline.adapterRevision.sourceId).toBe(
      adapterRevision.sourceId,
    );
    expect(result.candidate.adapterRevision.sourceId).toBe(
      adapterRevision.sourceId,
    );
    expect(result.patch).toMatchObject({
      rawSha256: result.patchIdentity.patchSha256,
      byteLength: result.patchIdentity.byteLength,
    });
    expect(
      result.workflowInput.executions.map((entry) => entry.executionId),
    ).toEqual(["execution:m6:agent-baseline", "execution:m6:agent-candidate"]);
    expect(JSON.stringify(result)).not.toMatch(/environmentRevision/iu);

    const checked = checkExternalHiddenFixWorkflowV1(result.workflowInput);
    expect(checked.outcome).toBe("verified");
    expect(
      checked.checks.find(
        (check) =>
          check.check ===
          "baseline_execution_before_host_observed_source_change",
      )?.satisfied,
    ).toBe(true);
  });

  it("uses the first source identity change observed at a Host tool boundary for baseline ordering", async () => {
    const project = await createProject();
    const fixture = createPort(project.workspace, project.baselineHash, {
      earlyChangedObservation: true,
    });
    const result = await runM6OneTurnAgentV1(
      request(project.workspace, project.baselineHash),
      fixture.port,
    );
    expect(result.status).toBe("workflow_ready");
    if (result.status !== "workflow_ready") {
      throw new Error("expected workflow evidence");
    }

    const checked = checkExternalHiddenFixWorkflowV1(result.workflowInput);
    expect(checked.outcome).toBe("rejected");
    expect(
      checked.checks.find(
        (check) =>
          check.check ===
          "baseline_execution_before_host_observed_source_change",
      )?.satisfied,
    ).toBe(false);
  });

  it.each([
    ["baseline", { omitBaselineExecution: true }, 1],
    ["candidate", { omitCandidateExecution: true }, 1],
    [
      "baseline or candidate",
      { omitBaselineExecution: true, omitCandidateExecution: true },
      0,
    ],
  ] as const)(
    "does not synthesize a missing Agent %s execution",
    async (_missing, options, expectedExecutions) => {
      const project = await createProject();
      const fixture = createPort(
        project.workspace,
        project.baselineHash,
        options,
      );
      const result = await runM6OneTurnAgentV1(
        request(project.workspace, project.baselineHash),
        fixture.port,
      );
      expect(result.status).toBe("workflow_ready");
      if (result.status !== "workflow_ready") {
        throw new Error("expected workflow evidence");
      }

      expect(result.workflowInput.executions).toHaveLength(expectedExecutions);
      expect(
        checkExternalHiddenFixWorkflowV1(result.workflowInput).outcome,
      ).toBe("rejected");
      expect(fixture.runAgentTurn).toHaveBeenCalledTimes(1);
      expect(fixture.runCompatibility).toHaveBeenCalledTimes(2);
      expect(fixture.freezePatch).toHaveBeenCalledTimes(1);
    },
  );

  it("does not retry or freeze a candidate after an Agent provider failure", async () => {
    const project = await createProject();
    const fixture = createPort(project.workspace, project.baselineHash, {
      agentStatus: "provider_failure",
    });
    const result = await runM6OneTurnAgentV1(
      request(project.workspace, project.baselineHash),
      fixture.port,
    );

    expect(result.status).toBe("agent_failed");
    expect(result.agentLoopStatus).toBe("provider_failure");
    expect(fixture.runAgentTurn).toHaveBeenCalledTimes(1);
    expect(fixture.runCompatibility).toHaveBeenCalledTimes(1);
    expect(fixture.freezePatch).not.toHaveBeenCalled();
    expect(fixture.cleanupTask).toHaveBeenCalledTimes(1);
  });

  it.each(["sha256", "byte_length"] as const)(
    "rejects a patch artifact reference whose %s does not match the same freeze identity",
    async (patchReferenceMismatch) => {
      const project = await createProject();
      const fixture = createPort(project.workspace, project.baselineHash, {
        patchReferenceMismatch,
      });

      await expect(
        runM6OneTurnAgentV1(
          request(project.workspace, project.baselineHash),
          fixture.port,
        ),
      ).rejects.toThrow(/artifact reference.*patch identity/iu);
      expect(fixture.runAgentTurn).toHaveBeenCalledTimes(1);
      expect(fixture.freezePatch).toHaveBeenCalledTimes(1);
      expect(fixture.cleanupTask).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects Host tool names that are not in the Adapter-backed protocol catalog", () => {
    expect(() =>
      createM6AdmittedGameToolsV1({
        adapterRevision,
        hostAdmittedToolNames: ["game_secret_oracle"],
      }),
    ).toThrow(/unknown game tool/iu);
  });
});
