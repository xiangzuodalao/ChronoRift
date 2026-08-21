import { execFile } from "node:child_process";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1,
  type ProjectEnvironmentGameToolNameV1,
} from "@chronorift/agent-protocol";
import { PROJECT_CAPABILITY_MODULE_NAMES_V1 } from "@chronorift/domain";
import type {
  ProjectEnvironmentGameToolPort,
  ProjectEnvironmentGameToolPortRequestV1,
  VNextCodingToolPort,
} from "@chronorift/pi-harness";
import {
  createProjectEnvironmentGameToolDefinitions,
  createVNextCodingToolDefinitions,
} from "@chronorift/pi-harness";

import {
  createPlatformAliasAblationEnvironmentV1,
  observePlatformAliasAblationPostflightV1,
  observePlatformAliasRuntimeV1,
  PLATFORM_ALIAS_ABLATION_ENVIRONMENT_INSTRUCTION_PROFILE,
  PLATFORM_ALIAS_ABLATION_ENVIRONMENT_PROFILE,
  PLATFORM_ALIAS_ABLATION_MODEL,
  PLATFORM_ALIAS_ABLATION_PROVIDER,
  PLATFORM_ALIAS_ABLATION_SHARED_TOOL_NAMES,
  PLATFORM_ALIAS_ABLATION_THINKING_LEVEL,
  PLATFORM_ALIAS_ABLATION_TIMEOUT_MS,
  PLATFORM_ALIAS_PROMPT,
  PlatformAliasAblationConfigurationV1Schema,
  PlatformAliasAblationRunV1Schema,
  platformAliasSourceStillExactV1,
  selectPlatformAliasAblationToolSurfaceV1,
} from "./platform-alias-demo.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

const git = async (repository: string, args: readonly string[]) =>
  execFileAsync("/usr/bin/git", args, {
    cwd: repository,
    env: {
      HOME: repository,
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });

const taskId = "task.test";
const buildId = "build.test";
const runtimeId = "runtime.test";
const executionId = "execution.test";
const clock = {
  schemaVersion: 1,
  processFrame: 1,
  physicsTick: 1,
  simulationTimeUs: 16_667,
  renderFrame: null,
  hostMonotonicUs: 10,
};
const modules = PROJECT_CAPABILITY_MODULE_NAMES_V1.map((module) => ({
  schemaVersion: 1 as const,
  module,
  status: "implemented" as const,
  protocolVersion: "project-adapter-module:v1",
  limitations: [],
}));
const coverage = [
  {
    schemaVersion: 1,
    channelId: "observations",
    status: "complete" as const,
    observedRecords: 2,
    droppedRecords: 0,
    overwrittenRecords: 0,
    limitations: [],
  },
];
const exposed = new Set<ProjectEnvironmentGameToolNameV1>([
  "game_capabilities",
  "game_launch",
  "game_query",
  "game_stop",
]);

class RuntimePort implements ProjectEnvironmentGameToolPort {
  public readonly requests: ProjectEnvironmentGameToolPortRequestV1[] = [];
  public failStateQuery = false;

  public invoke(request: ProjectEnvironmentGameToolPortRequestV1) {
    this.requests.push(structuredClone(request));
    const output = this.output(request);
    return Promise.resolve(
      output === null
        ? {
            schemaVersion: 1,
            toolCallId: request.toolCallId,
            outcome: "error",
            error: {
              code: "operation_failed",
              message: "state query failed",
              recoverable: true,
            },
          }
        : {
            schemaVersion: 1,
            toolCallId: request.toolCallId,
            outcome: "success",
            output,
          },
    );
  }

  private output(request: ProjectEnvironmentGameToolPortRequestV1) {
    switch (request.toolName) {
      case "game_capabilities":
        return {
          schemaVersion: 1,
          taskId,
          environmentRevisionId: "environment.test",
          adapterRevisionId: "adapter.test",
          buildId,
          runtimeId: null,
          modules,
          tools: PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1.filter((tool) =>
            exposed.has(tool.name),
          ).map((tool) => ({
            schemaVersion: 1,
            toolName: tool.name,
            module: tool.availabilityModule,
            status: "available" as const,
            limitations: [],
          })),
          limitations: [],
        };
      case "game_launch":
        return {
          schemaVersion: 1,
          taskId,
          runtimeId,
          executionId,
          buildId,
          environmentRevisionId: "environment.test",
          adapterRevisionId: "adapter.test",
          launchReceiptId: "launch.test",
          requested: { launchTargetId: "main", parameters: {} },
          realized: {
            launchTargetId: "main",
            parameters: {},
            renderer: "headless",
            clock,
          },
          status: "running" as const,
          modules,
          limitations: [],
        };
      case "game_query": {
        const select = (request.input as { readonly select: string }).select;
        if (select === "state" && this.failStateQuery) return null;
        return {
          schemaVersion: 1,
          taskId,
          executionId,
          rows: [
            {
              schemaVersion: 1,
              rowId: `row.${select}`,
              kind:
                select === "entities"
                  ? "entity"
                  : select === "runtime_errors"
                    ? "runtime_error"
                    : "state",
              clock: null,
              value: { observed: select },
            },
          ],
          nextCursor: null,
          coverage,
          loss: [],
          limitations: [],
        };
      }
      case "game_stop":
        return {
          schemaVersion: 1,
          taskId,
          runtimeId,
          executionId,
          status: "stopped" as const,
          cleanup: {
            schemaVersion: 1,
            processTreeTerminated: true,
            runtimeExited: true,
            bridgeExited: true,
            isolationGroupEmpty: true,
            scopeRemoved: true,
            scratchRemoved: true,
            storageReconciled: true,
          },
          coverage,
          loss: [],
          limitations: [],
        };
      default:
        throw new Error(`unexpected tool ${request.toolName}`);
    }
  }
}

describe("GN-1 platform alias observation", () => {
  it("keeps the matched prompt and raw Godot tool shared while ablating only ChronoRift tools", () => {
    expect(PLATFORM_ALIAS_PROMPT).toBe(
      "A falling platform can activate while the player is still outside its visible width. Investigate the project, make the smallest appropriate fix, and validate the candidate. You choose the investigation, edit, and validation strategy.",
    );
    expect(PLATFORM_ALIAS_PROMPT).not.toMatch(
      /ChronoRift|game_|runtime|observation|geometry|resource|tool/iu,
    );
    const codingTools = createVNextCodingToolDefinitions(
      {} as VNextCodingToolPort,
    ).map((tool) => ({ name: tool.name }));
    const godotRunTool = { name: "godot_run" };
    const chronoriftTools = createProjectEnvironmentGameToolDefinitions(
      new RuntimePort(),
      { schemaVersion: 1, modules },
      {
        includedToolNames: [
          "game_capabilities",
          "game_launch",
          "game_query",
          "game_stop",
        ],
        queryInputProfile: "pe-a-v1-narrow",
      },
    );
    const queryTool = chronoriftTools.find(
      (tool) => tool.name === "game_query",
    );
    expect(JSON.stringify(queryTool?.parameters)).not.toMatch(
      /"filters"|"cursor"/u,
    );
    const control = selectPlatformAliasAblationToolSurfaceV1({
      arm: "coding-only",
      codingTools,
      godotRunTool,
      chronoriftTools,
    });
    const treatment = selectPlatformAliasAblationToolSurfaceV1({
      arm: "chronorift",
      codingTools,
      godotRunTool,
      chronoriftTools,
    });

    expect(control.sharedTools.map((tool) => tool.name)).toEqual(
      PLATFORM_ALIAS_ABLATION_SHARED_TOOL_NAMES,
    );
    expect(treatment.sharedTools.map((tool) => tool.name)).toEqual(
      PLATFORM_ALIAS_ABLATION_SHARED_TOOL_NAMES,
    );
    expect(control.chronoriftTools).toEqual([]);
    expect(treatment.chronoriftTools.map((tool) => tool.name)).toEqual(
      chronoriftTools.map((tool) => tool.name),
    );
    expect(control.tools.map((tool) => tool.name)).toEqual(
      PLATFORM_ALIAS_ABLATION_SHARED_TOOL_NAMES,
    );
  });

  it("uses the same task-id-only coding environment in both arms", () => {
    const control = createPlatformAliasAblationEnvironmentV1({
      taskId: "task.control",
    });
    const treatment = createPlatformAliasAblationEnvironmentV1({
      taskId: "task.treatment",
    });

    expect(control.environmentProfile).toBe("coding");
    expect(treatment.environmentProfile).toBe("coding");
    expect(
      control.additionalEnvironmentInstructions.replace(
        "task.control",
        "task.matched",
      ),
    ).toBe(
      treatment.additionalEnvironmentInstructions.replace(
        "task.treatment",
        "task.matched",
      ),
    );
    expect(control.additionalEnvironmentInstructions).toBe(
      "Task context:\n- taskId: task.control",
    );
    expect(JSON.stringify([control, treatment])).not.toMatch(
      /GN-1|game|platform|runtime|launch|Shape/iu,
    );
  });

  it("strictly freezes the requested Luna/max ablation configuration", () => {
    const base = {
      schemaVersion: 1 as const,
      provider: PLATFORM_ALIAS_ABLATION_PROVIDER,
      model: PLATFORM_ALIAS_ABLATION_MODEL,
      thinkingLevel: PLATFORM_ALIAS_ABLATION_THINKING_LEVEL,
      timeoutMs: PLATFORM_ALIAS_ABLATION_TIMEOUT_MS,
      environmentProfile: PLATFORM_ALIAS_ABLATION_ENVIRONMENT_PROFILE,
      environmentInstructionProfile:
        PLATFORM_ALIAS_ABLATION_ENVIRONMENT_INSTRUCTION_PROFILE,
      prompt: PLATFORM_ALIAS_PROMPT,
      sourceCommit: "e78b339500dec8e480b33723c4156bf9b74cd25c",
      sourceTree: "9941cb045b3cd73c4554ca1de337a341b383590b",
      sharedToolNames: PLATFORM_ALIAS_ABLATION_SHARED_TOOL_NAMES,
      chronoriftToolNames: [],
    };
    expect(PlatformAliasAblationConfigurationV1Schema.parse(base)).toEqual(
      base,
    );
    expect(
      PlatformAliasAblationConfigurationV1Schema.safeParse({
        ...base,
        model: "gpt-5.6-sol",
      }).success,
    ).toBe(false);
    expect(
      PlatformAliasAblationConfigurationV1Schema.safeParse({
        ...base,
        timeoutMs: 599_999,
      }).success,
    ).toBe(false);
  });

  it("strictly binds each ablation arm to its realized active tool surface", () => {
    const observation = {
      schemaVersion: 1 as const,
      buildId,
      runtimeId,
      executionId,
      capabilities: {},
      launch: {},
      entities: {},
      state: {},
      stop: {},
    };
    const baseResult = {
      schemaVersion: 1 as const,
      commandStatus: "completed" as const,
      taskId,
      source: {
        schemaVersion: 1 as const,
        repositoryRoot: "/tmp/source",
        commit: "e78b339500dec8e480b33723c4156bf9b74cd25c",
        tree: "9941cb045b3cd73c4554ca1de337a341b383590b",
        selectedTreeSha256:
          "0000000000000000000000000000000000000000000000000000000000000000",
        checkoutCleanBefore: true as const,
        checkoutCleanAfter: true,
      },
      baselineObservation: observation,
      agent: {
        schemaVersion: 1 as const,
        status: "completed" as const,
        sessionId: "session.test",
        sessionFile: "/tmp/session.jsonl",
        provider: PLATFORM_ALIAS_ABLATION_PROVIDER,
        model: PLATFORM_ALIAS_ABLATION_MODEL,
        requestedThinkingLevel: PLATFORM_ALIAS_ABLATION_THINKING_LEVEL,
        realizedThinkingLevel: PLATFORM_ALIAS_ABLATION_THINKING_LEVEL,
        activeTools: [...PLATFORM_ALIAS_ABLATION_SHARED_TOOL_NAMES],
        assistantText: "done",
        errorMessage: null,
        eventsObserved: 1,
        stats: null,
        gameToolCalls: [],
      },
      candidatePatch: {
        schemaVersion: 1 as const,
        sha256:
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        byteLength: 0,
        unifiedDiff: "",
      },
      candidateObservation: observation,
      candidateObservationError: null,
      workspaceDirectory: "/tmp/workspace",
      taskDirectory: "/tmp/task",
      cleanupReceipt: {
        processGroupTerminated: true,
        cgroupPopulated: false,
        termSent: false,
        killSent: false,
        scopeRemoved: true,
      },
      securityEvents: [],
      limitations: ["single pair"],
    };
    const configuration = {
      schemaVersion: 1 as const,
      provider: PLATFORM_ALIAS_ABLATION_PROVIDER,
      model: PLATFORM_ALIAS_ABLATION_MODEL,
      thinkingLevel: PLATFORM_ALIAS_ABLATION_THINKING_LEVEL,
      timeoutMs: PLATFORM_ALIAS_ABLATION_TIMEOUT_MS,
      environmentProfile: PLATFORM_ALIAS_ABLATION_ENVIRONMENT_PROFILE,
      environmentInstructionProfile:
        PLATFORM_ALIAS_ABLATION_ENVIRONMENT_INSTRUCTION_PROFILE,
      prompt: PLATFORM_ALIAS_PROMPT,
      sourceCommit: "e78b339500dec8e480b33723c4156bf9b74cd25c",
      sourceTree: "9941cb045b3cd73c4554ca1de337a341b383590b",
      sharedToolNames: PLATFORM_ALIAS_ABLATION_SHARED_TOOL_NAMES,
      chronoriftToolNames: [] as const,
    };
    const control = {
      schemaVersion: 1 as const,
      arm: "coding-only" as const,
      configuration,
      result: baseResult,
      rawGodotToolCalls: [],
      candidateRuntimeErrors: { schemaVersion: 1, rows: [] },
      candidateRuntimeErrorsError: null,
    };

    expect(PlatformAliasAblationRunV1Schema.parse(control)).toEqual(control);
    expect(
      PlatformAliasAblationRunV1Schema.safeParse({
        ...control,
        result: {
          ...baseResult,
          agent: {
            ...baseResult.agent,
            activeTools: [...baseResult.agent.activeTools, "game_capabilities"],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      PlatformAliasAblationRunV1Schema.safeParse({
        ...control,
        arm: "chronorift",
      }).success,
    ).toBe(false);
    expect(
      PlatformAliasAblationRunV1Schema.safeParse({
        ...control,
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it("does not execute source-checkout filters or fsmonitor hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-gn1-source-check-"));
    temporaryRoots.push(root);
    const repository = join(root, "repository");
    await mkdir(repository);
    const filterMarker = join(root, "filter-ran");
    const fsmonitorMarker = join(root, "fsmonitor-ran");
    const fsmonitor = join(root, "hostile-fsmonitor.sh");
    await writeFile(
      fsmonitor,
      `#!/bin/sh\ntouch "${fsmonitorMarker}"\nexit 0\n`,
      { mode: 0o755 },
    );
    await git(repository, ["init", "--quiet"]);
    await git(repository, ["config", "user.name", "ChronoRift Test"]);
    await git(repository, [
      "config",
      "user.email",
      "chronorift-test@invalid.local",
    ]);
    await writeFile(
      join(repository, ".gitattributes"),
      "*.gd filter=hostile\n",
    );
    await writeFile(join(repository, "main.gd"), "extends Node\n");
    await git(repository, ["add", "--all"]);
    await git(repository, ["commit", "--quiet", "-m", "baseline"]);
    await git(repository, [
      "config",
      "filter.hostile.clean",
      `/bin/sh -c 'touch "${filterMarker}"; cat'`,
    ]);
    await git(repository, ["config", "core.fsmonitor", fsmonitor]);
    await appendFile(join(repository, "main.gd"), "# dirty\n");

    await expect(platformAliasSourceStillExactV1(repository)).resolves.toBe(
      false,
    );
    await expect(access(filterMarker)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(fsmonitorMarker)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("captures entities and state between exact launch and stop calls", async () => {
    const runtime = new RuntimePort();
    const observed = await observePlatformAliasRuntimeV1(
      runtime,
      taskId,
      "main",
    );

    expect(observed).toMatchObject({
      schemaVersion: 1,
      buildId,
      runtimeId,
      executionId,
    });
    expect(runtime.requests.map((request) => request.toolName)).toEqual([
      "game_capabilities",
      "game_launch",
      "game_query",
      "game_query",
      "game_stop",
    ]);
    expect(
      runtime.requests.slice(2, 4).map((request) => request.input),
    ).toEqual([
      {
        schemaVersion: 1,
        taskId,
        executionId,
        select: "entities",
        limit: 200,
      },
      {
        schemaVersion: 1,
        taskId,
        executionId,
        select: "state",
        limit: 200,
      },
    ]);
  });

  it("still stops a launched runtime when the state query fails", async () => {
    const runtime = new RuntimePort();
    runtime.failStateQuery = true;

    await expect(
      observePlatformAliasRuntimeV1(runtime, taskId, "main"),
    ).rejects.toThrow("game_query failed");
    expect(runtime.requests.at(-1)?.toolName).toBe("game_stop");
  });

  it("captures candidate runtime errors before stopping the postflight", async () => {
    const runtime = new RuntimePort();

    const postflight = await observePlatformAliasAblationPostflightV1(
      runtime,
      taskId,
      "main",
    );

    expect(postflight.runtimeErrors).toMatchObject({
      schemaVersion: 1,
      taskId,
      executionId,
      rows: [
        expect.objectContaining({ value: { observed: "runtime_errors" } }),
      ],
    });
    expect(runtime.requests.map((request) => request.toolName)).toEqual([
      "game_capabilities",
      "game_launch",
      "game_query",
      "game_query",
      "game_query",
      "game_stop",
    ]);
    expect(runtime.requests.at(-2)?.input).toMatchObject({
      select: "runtime_errors",
    });
  });
});
