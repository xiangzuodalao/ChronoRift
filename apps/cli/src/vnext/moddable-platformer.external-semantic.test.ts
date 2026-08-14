import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  SEMANTIC_GAME_TOOL_NAMES_V1,
  validateSemanticGameToolOutputV1,
  type SemanticGameToolNameV1,
} from "@chronorift/agent-protocol";
import { asTaskId, type JsonValue } from "@chronorift/domain";
import {
  DEFAULT_SEMANTIC_SIDECAR_TARGETS,
  createSemanticRuntimeSidecarSource,
  createSemanticVanillaSmokeSidecarSource,
} from "@chronorift/godot-adapter";
import { describe, expect, it } from "vitest";

import { createExternalGodotSemanticCoordinator } from "./external-godot-semantic-coordinator.js";
import { readGodotProjectDescriptorSnapshotV1 } from "./godot-project-descriptor.js";
import {
  discardM1Task,
  getM1TaskExternalGodotSemanticRuntimeContext,
  prepareM1TaskEnvironment,
  suspendM1Task,
  type M1TaskEnvironment,
} from "./m1-task-environment.js";
import { readGodotSemanticAdapterProfileSnapshotV1 } from "./semantic-adapter-profile.js";

const execFileAsync = promisify(execFile);
const FROZEN_COMMIT = "3e793f53598a131c53fb82555191cc14b8db07ff";
const FROZEN_TREE = "a013bd677c712dbf354e8e2f6e8ff7c53d5684c6";
const FROZEN_SELECTED_TREE =
  "3e8bd6478d53586284010da38959005e2a377ef6277b2a838ecb1538abc096e8";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for E2 external semantic conformance`);
  }
  return value;
};

const git = async (root: string, args: readonly string[]): Promise<string> => {
  const result = await execFileAsync("/usr/bin/git", args, {
    cwd: root,
    env: {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    encoding: "utf8",
  });
  return result.stdout.trim();
};

const loadInputs = async () => {
  const sourceRoot = required("CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT");
  const descriptorPath = required(
    "CHRONORIFT_TEST_EXTERNAL_PROJECT_DESCRIPTOR",
  );
  const adapterPath = required(
    "CHRONORIFT_TEST_EXTERNAL_SEMANTIC_ADAPTER_PROFILE",
  );
  const taskStorageRoot = required("CHRONORIFT_TEST_TASK_STORAGE_ROOT");
  const cgroupRoot = required("CHRONORIFT_TEST_CGROUP_ROOT");
  const nodePath = required("CHRONORIFT_TEST_NODE_BIN");
  const godotPath = required("CHRONORIFT_TEST_GODOT_BIN");
  const semanticAddonRoot = required(
    "CHRONORIFT_TEST_GODOT_SEMANTIC_ADDON_ROOT",
  );
  const bwrapPath = required("CHRONORIFT_TEST_BWRAP_BIN");
  const prlimitPath = required("CHRONORIFT_TEST_PRLIMIT_BIN");
  const busyboxPath = required("CHRONORIFT_TEST_BUSYBOX_BIN");
  const lddPath = required("CHRONORIFT_TEST_LDD_BIN");
  const fontconfigProbePath = required("CHRONORIFT_TEST_FONTCONFIG_PROBE_BIN");
  const xdgUserDirPath = required("CHRONORIFT_TEST_XDG_USER_DIR_BIN");
  const bashPath = required("CHRONORIFT_TEST_BASH_BIN");
  const rgPath = required("CHRONORIFT_TEST_RG_BIN");
  const findPath = required("CHRONORIFT_TEST_FIND_BIN");
  const lsPath = required("CHRONORIFT_TEST_LS_BIN");
  const evidenceOutput = required("CHRONORIFT_TEST_SEMANTIC_EVIDENCE_OUTPUT");
  for (const path of [
    sourceRoot,
    descriptorPath,
    adapterPath,
    taskStorageRoot,
    cgroupRoot,
    nodePath,
    godotPath,
    semanticAddonRoot,
    bwrapPath,
    prlimitPath,
    busyboxPath,
    lddPath,
    fontconfigProbePath,
    xdgUserDirPath,
    bashPath,
    rgPath,
    findPath,
    lsPath,
  ]) {
    expect(await realpath(path)).toBe(path);
  }
  return {
    sourceRoot,
    descriptorPath,
    adapterPath,
    taskStorageRoot,
    cgroupRoot,
    nodePath,
    godotPath,
    semanticAddonRoot,
    bwrapPath,
    prlimitPath,
    busyboxPath,
    lddPath,
    fontconfigProbePath,
    xdgUserDirPath,
    bashPath,
    rgPath,
    findPath,
    lsPath,
    evidenceOutput,
  };
};

describe("frozen moddable-platformer E2 semantic conformance", () => {
  it("runs all eleven semantic tools against the public exposed Timer/spawn task", async () => {
    const input = await loadInputs();
    expect(await git(input.sourceRoot, ["rev-parse", "HEAD"])).toBe(
      FROZEN_COMMIT,
    );
    expect(await git(input.sourceRoot, ["rev-parse", "HEAD^{tree}"])).toBe(
      FROZEN_TREE,
    );
    expect(
      await git(input.sourceRoot, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignored=matching",
      ]),
    ).toBe("");

    const taskId = asTaskId("task:e2-external-semantic-conformance");
    const runtimeRoot = await mkdtemp(
      join(input.taskStorageRoot, "chronorift-e2-runtime-"),
    );
    const descriptorSnapshot = await readGodotProjectDescriptorSnapshotV1(
      input.descriptorPath,
    );
    const semanticAdapterProfile =
      await readGodotSemanticAdapterProfileSnapshotV1(input.adapterPath);
    const sandboxHost = {
      delegatedCgroupRoot: input.cgroupRoot,
      bwrapPath: input.bwrapPath,
      prlimitPath: input.prlimitPath,
      busyboxPath: input.busyboxPath,
      taskStorageRoot: input.taskStorageRoot,
    };
    const sandboxToolchain = {
      lddPath: input.lddPath,
      commands: [
        { target: "/bin/bash", hostPath: input.bashPath },
        { target: "/usr/bin/find", hostPath: input.findPath },
        { target: "/usr/bin/ls", hostPath: input.lsPath },
        { target: "/usr/bin/rg", hostPath: input.rgPath },
      ],
    };
    const managedGodotSemanticRuntime = {
      nodePath: input.nodePath,
      godotPath: input.godotPath,
      fontconfigProbePath: input.fontconfigProbePath,
      shellPath: input.busyboxPath,
      xdgUserDirPath: input.xdgUserDirPath,
      lddPath: input.lddPath,
      addonRoot: input.semanticAddonRoot,
      vanillaSidecarSource: createSemanticVanillaSmokeSidecarSource({
        godotExecutable: DEFAULT_SEMANTIC_SIDECAR_TARGETS.godotExecutable,
        workspaceRoot: DEFAULT_SEMANTIC_SIDECAR_TARGETS.workspaceRoot,
        runtimeRoot: DEFAULT_SEMANTIC_SIDECAR_TARGETS.runtimeRoot,
      }),
      semanticSidecarSource: createSemanticRuntimeSidecarSource({
        godotExecutable: DEFAULT_SEMANTIC_SIDECAR_TARGETS.godotExecutable,
        workspaceRoot: DEFAULT_SEMANTIC_SIDECAR_TARGETS.workspaceRoot,
        runtimeRoot: DEFAULT_SEMANTIC_SIDECAR_TARGETS.runtimeRoot,
      }),
    };
    let environment: M1TaskEnvironment | undefined;
    let coordinator:
      ReturnType<typeof createExternalGodotSemanticCoordinator> | undefined;
    let evidence: JsonValue | undefined;
    try {
      environment = await prepareM1TaskEnvironment({
        taskId,
        projectPath: input.sourceRoot,
        externalProjectDescriptor: descriptorSnapshot,
        semanticAdapterProfile,
        runtimeRoot,
        sandboxHost,
        sandboxToolchain,
        managedGodotSemanticRuntime,
      });
      const context = getM1TaskExternalGodotSemanticRuntimeContext(environment);
      expect(context.baselineSourceHash).toBe(FROZEN_SELECTED_TREE);
      coordinator = createExternalGodotSemanticCoordinator({
        taskId: context.taskId,
        workspaceId: context.workspaceId,
        workspaceDirectory: context.workspaceDirectory,
        baselineSourceHash: context.baselineSourceHash,
        projectCapability: context.projectCapability,
        managedRuntime: context.managedSemanticRuntime,
        adapterProfile: context.semanticAdapterProfile.profile,
        adapterProfileSha256:
          context.semanticAdapterProfile.adapterProfileSha256,
        sidecarPort: context.sidecarPort,
        runtimeStore: context.runtimeStore,
      });
      let call = 0;
      const invoke = async (
        toolName: SemanticGameToolNameV1,
        request: Record<string, unknown>,
      ): Promise<Record<string, unknown>> => {
        call += 1;
        const response = await coordinator!.invoke({
          schemaVersion: 1,
          toolCallId: `e2:${String(call)}`,
          toolName,
          input: { schemaVersion: 1, taskId, ...request },
        });
        expect(
          response.outcome,
          response.outcome === "error"
            ? `${toolName} failed: ${response.error.code}: ${response.error.message}`
            : `${toolName} failed`,
        ).toBe("success");
        if (response.outcome !== "success") {
          throw new Error(`${response.error.code}: ${response.error.message}`);
        }
        expect(
          validateSemanticGameToolOutputV1(toolName, response.output),
        ).toBe(true);
        return response.output as Record<string, unknown>;
      };

      const capabilities = await invoke("game_capabilities", {});
      expect(
        (capabilities["tools"] as Array<{ name: string }>).map(
          (entry) => entry.name,
        ),
      ).toEqual(SEMANTIC_GAME_TOOL_NAMES_V1);
      const buildId = String(
        (capabilities["build"] as Record<string, unknown>)["buildId"],
      );
      const launched = await invoke("game_launch", { buildId });
      const baseline = launched["runtime"] as Record<string, unknown>;
      const baselineRuntimeId = String(baseline["runtimeId"]);
      const baselineExecutionId = String(baseline["executionId"]);
      await invoke("game_status", { runtimeId: baselineRuntimeId });
      const checkpointOutput = await invoke("game_checkpoint_create", {
        runtimeId: baselineRuntimeId,
        barrier: "adapter_process_tail",
      });
      const checkpoint = checkpointOutput["checkpoint"] as Record<
        string,
        unknown
      >;
      expect(checkpoint["fidelity"]).toBe("descriptive_only");
      const checkpointId = String(checkpoint["checkpointId"]);
      const traceOutput = await invoke("game_trace_create", {
        runtimeId: baselineRuntimeId,
        clockDomain: "physics_tick",
        sampleOffsets: [1, 2],
      });
      const traceId = String(
        (traceOutput["trace"] as Record<string, unknown>)["traceId"],
      );
      await invoke("game_stop", { runtimeId: baselineRuntimeId });
      await invoke("game_query", {
        source: { kind: "execution", executionId: baselineExecutionId },
        view: "entities",
        limit: 200,
      });
      const forked = await invoke("game_fork", {
        source: { kind: "checkpoint", checkpointId },
        checkpointId,
      });
      expect(forked["fidelity"]).toBe("descriptive_only");
      const childRuntimeId = String(forked["childRuntimeId"]);
      const childExecutionId = String(forked["childExecutionId"]);
      await invoke("game_checkpoint_restore", {
        runtimeId: childRuntimeId,
        checkpointId,
      });
      await invoke("game_trace_replay", {
        runtimeId: childRuntimeId,
        traceId,
        maxTicks: 30,
      });
      await invoke("game_stop", { runtimeId: childRuntimeId });
      const comparison = await invoke("game_compare", {
        baselineExecutionId,
        candidateExecutionId: childExecutionId,
        maxDifferences: 200,
      });
      expect(["descriptive_only", "confounded"]).toContain(comparison["mode"]);

      const summary = await context.runtimeStore.summarize();
      expect(summary.executions).toHaveLength(2);
      expect(summary.executions.every((entry) => entry.sealed)).toBe(true);
      evidence = {
        schemaVersion: 1,
        evidenceKind: "chronorift-e2-public-exposed-semantic-conformance",
        sourceCommit: FROZEN_COMMIT,
        sourceSelectedTreeSha256: FROZEN_SELECTED_TREE,
        adapterProfileSha256:
          context.semanticAdapterProfile.adapterProfileSha256,
        protocolProfile: context.managedSemanticRuntime.protocolProfile,
        toolNames: [...SEMANTIC_GAME_TOOL_NAMES_V1],
        executionCount: summary.executions.length,
        allExecutionsSealed: summary.executions.every((entry) => entry.sealed),
        fidelity: "descriptive_only",
        taskClassification: "public_exposed_plumbing_conformance",
        claimsExcluded: [
          "intelligent_diagnosis",
          "independent_acceptance",
          "equivalent_checkpoint_restore",
          "causality",
          "generalization",
        ],
      } satisfies JsonValue;

      await coordinator.close();
      coordinator = undefined;
      const cleanup = await suspendM1Task(environment);
      expect(cleanup).toMatchObject({
        processGroupTerminated: true,
        cgroupPopulated: false,
        scopeRemoved: true,
        storageReconciled: true,
      });
      await discardM1Task(environment);
      environment = undefined;
      await rm(runtimeRoot, { recursive: true, force: true });
    } finally {
      await coordinator?.close().catch(() => undefined);
      if (environment !== undefined) {
        await suspendM1Task(environment).catch(() => undefined);
        await discardM1Task(environment).catch(() => undefined);
      }
      await rm(runtimeRoot, { recursive: true, force: true });
    }
    expect(
      await git(input.sourceRoot, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignored=matching",
      ]),
    ).toBe("");
    if (evidence === undefined) throw new Error("semantic evidence is missing");
    await writeFile(input.evidenceOutput, `${JSON.stringify(evidence)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    expect(
      JSON.parse(await readFile(input.evidenceOutput, "utf8")),
    ).toMatchObject({
      allExecutionsSealed: true,
      fidelity: "descriptive_only",
      taskClassification: "public_exposed_plumbing_conformance",
    });
  }, 600_000);
});
