import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1,
  PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1,
  type ProjectEnvironmentGameToolNameV1,
} from "@chronorift/agent-protocol";
import {
  PROJECT_CAPABILITY_MODULE_NAMES_V1,
  PROJECT_READY_REQUIRED_MODULE_NAMES_V1,
  type ProjectCapabilitySetV1,
} from "@chronorift/domain";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  createProjectEnvironmentGameToolDefinitions,
  createProjectEnvironmentToolCallAdmissionV1,
  projectEnvironmentUnsupportedCapabilityResponseV1,
  type ProjectEnvironmentGameToolPort,
  type ProjectEnvironmentGameToolPortRequestV1,
  type ProjectEnvironmentGameToolResponseV1,
} from "../src/index.js";

const capabilitySet = (
  overrides: Readonly<
    Record<string, "implemented" | "degraded" | "unsupported">
  > = {},
): ProjectCapabilitySetV1 => ({
  schemaVersion: 1,
  modules: PROJECT_CAPABILITY_MODULE_NAMES_V1.map((module) => {
    const status =
      overrides[module] ??
      (PROJECT_READY_REQUIRED_MODULE_NAMES_V1.includes(
        module as (typeof PROJECT_READY_REQUIRED_MODULE_NAMES_V1)[number],
      )
        ? "implemented"
        : "unsupported");
    return {
      schemaVersion: 1,
      module,
      status,
      protocolVersion:
        status === "implemented" || status === "degraded"
          ? "chronorift.project-module:v1"
          : null,
      limitations:
        status === "implemented"
          ? []
          : status === "degraded"
            ? ["partial adapter coverage"]
            : ["adapter did not implement this module"],
    };
  }),
});

const errorResponse = (
  toolCallId: string,
): ProjectEnvironmentGameToolResponseV1 => ({
  schemaVersion: 1,
  toolCallId,
  outcome: "error",
  error: {
    code: "operation_failed",
    message: "fixture port stopped",
    recoverable: true,
  },
});

class MemoryProjectEnvironmentPort implements ProjectEnvironmentGameToolPort {
  public readonly requests: ProjectEnvironmentGameToolPortRequestV1[] = [];
  public response: unknown;

  public invoke(
    request: ProjectEnvironmentGameToolPortRequestV1,
  ): Promise<unknown> {
    this.requests.push(structuredClone(request));
    return Promise.resolve(this.response ?? errorResponse(request.toolCallId));
  }
}

const execute = async (
  port: MemoryProjectEnvironmentPort,
  capabilities: ProjectCapabilitySetV1,
  name: string,
  input: Record<string, unknown>,
) => {
  const tool = createProjectEnvironmentGameToolDefinitions(
    port,
    capabilities,
  ).find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool.execute("call:pe-a", input, undefined, undefined, {} as never);
};

describe("Project Environment Pi game-tool binding", () => {
  it("registers all 16 tools even when optional modules are unsupported", () => {
    const tools = createProjectEnvironmentGameToolDefinitions(
      new MemoryProjectEnvironmentPort(),
      capabilitySet(),
    );
    expect(tools).toHaveLength(16);
    expect(tools.map((tool) => tool.name)).toEqual(
      Object.values(PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1),
    );
    for (const [index, tool] of tools.entries()) {
      expect(tool.parameters).toBe(
        PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1[index]?.parameters,
      );
    }
  });

  it("gives every selected game tool a catalog snippet and one shared conditional guideline", () => {
    const tools = createProjectEnvironmentGameToolDefinitions(
      new MemoryProjectEnvironmentPort(),
      capabilitySet(),
    );

    expect(tools).toHaveLength(
      PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1.length,
    );
    const guidelines = new Set<string>();
    for (const [index, tool] of tools.entries()) {
      expect(tool.promptSnippet).toBe(
        PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1[index]?.description,
      );
      expect(tool.promptGuidelines).toHaveLength(1);
      const guideline = tool.promptGuidelines?.[0];
      if (guideline === undefined) throw new Error("missing prompt guideline");
      guidelines.add(guideline);
    }
    expect(guidelines).toHaveLength(1);
    expect([...guidelines][0]).toMatch(
      /game tools.*realized geometry.*runtime state.*history/iu,
    );
    expect([...guidelines][0]).not.toMatch(
      /call first|only after|exactly once|must .* before/iu,
    );
  });

  it("surfaces the selected game tools and deduplicated guideline in Pi's default system prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-game-prompt-"));
    const workspace = join(root, "workspace");
    const agentDir = join(root, "agent");
    await Promise.all([mkdir(workspace), mkdir(agentDir)]);

    try {
      const tools = createProjectEnvironmentGameToolDefinitions(
        new MemoryProjectEnvironmentPort(),
        capabilitySet(),
        {
          includedToolNames: [
            "game_capabilities",
            "game_launch",
            "game_stop",
            "game_query",
          ],
        },
      );
      const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
      });
      const model = modelRuntime.getModels()[0];
      if (model === undefined) throw new Error("missing built-in Pi model");
      const { session } = await createAgentSession({
        cwd: workspace,
        agentDir,
        modelRuntime,
        model,
        thinkingLevel: "off",
        noTools: "all",
        tools: tools.map((tool) => tool.name),
        customTools: [...tools],
        sessionManager: SessionManager.inMemory(workspace),
        settingsManager: SettingsManager.inMemory(),
      });

      try {
        const availableTools = session.systemPrompt
          .split("Available tools:\n", 2)[1]
          ?.split("\n\nIn addition to the tools above", 1)[0];
        expect(availableTools).toBe(
          tools
            .map((tool) => `- ${tool.name}: ${tool.promptSnippet}`)
            .join("\n"),
        );
        const guideline = tools[0]?.promptGuidelines?.[0];
        if (guideline === undefined)
          throw new Error("missing prompt guideline");
        expect(session.systemPrompt.split(`- ${guideline}`).length - 1).toBe(1);
      } finally {
        session.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("registers only a validated, deduplicated subset in catalog order", () => {
    const tools = createProjectEnvironmentGameToolDefinitions(
      new MemoryProjectEnvironmentPort(),
      capabilitySet(),
      {
        includedToolNames: [
          "game_query",
          "game_capabilities",
          "game_launch",
          "game_query",
          "game_stop",
        ],
      },
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      "game_capabilities",
      "game_launch",
      "game_stop",
      "game_query",
    ]);
  });

  it("exposes and enforces the PE-A V1 narrow game_query input profile", async () => {
    const port = new MemoryProjectEnvironmentPort();
    const query = createProjectEnvironmentGameToolDefinitions(
      port,
      capabilitySet(),
      {
        includedToolNames: ["game_query"],
        queryInputProfile: "pe-a-v1-narrow",
      },
    )[0];
    if (query === undefined) throw new Error("missing game_query tool");

    expect(query.parameters).toMatchObject({
      additionalProperties: false,
      required: ["schemaVersion", "taskId", "executionId", "select", "limit"],
    });
    expect(JSON.stringify(query.parameters)).not.toMatch(/"filters"|"cursor"/u);

    const validInput = {
      schemaVersion: 1,
      taskId: "task:pe-a",
      executionId: "execution:pe-a",
      select: "state",
      limit: 20,
    };
    await expect(
      query.execute(
        "call:narrow-valid",
        validInput,
        undefined,
        undefined,
        {} as never,
      ),
    ).resolves.toBeDefined();
    await expect(
      query.execute(
        "call:narrow-filter",
        { ...validInput, filters: { domainIds: ["platform_geometry"] } },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/Invalid input for game_query/u);
    await expect(
      query.execute(
        "call:narrow-cursor",
        { ...validInput, cursor: "cursor:next" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/Invalid input for game_query/u);
    expect(port.requests).toHaveLength(1);
  });

  it("keeps the canonical game_query input profile as the default", async () => {
    const port = new MemoryProjectEnvironmentPort();
    const query = createProjectEnvironmentGameToolDefinitions(
      port,
      capabilitySet(),
      { includedToolNames: ["game_query"] },
    )[0];
    if (query === undefined) throw new Error("missing game_query tool");

    expect(query.parameters).toBe(
      PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1.find(
        ({ name }) => name === "game_query",
      )?.parameters,
    );
    await expect(
      query.execute(
        "call:canonical",
        {
          schemaVersion: 1,
          taskId: "task:pe-a",
          executionId: "execution:pe-a",
          select: "state",
          filters: { domainIds: ["platform_geometry"] },
          limit: 20,
          cursor: "cursor:next",
        },
        undefined,
        undefined,
        {} as never,
      ),
    ).resolves.toBeDefined();
    expect(port.requests).toHaveLength(1);
  });

  it("rejects unknown included tool names", () => {
    expect(() =>
      createProjectEnvironmentGameToolDefinitions(
        new MemoryProjectEnvironmentPort(),
        capabilitySet(),
        {
          includedToolNames: [
            "game_capabilities",
            "game_unknown",
          ] as readonly ProjectEnvironmentGameToolNameV1[],
        },
      ),
    ).toThrow(/Unknown Project Environment game tool/u);
    expect(() =>
      createProjectEnvironmentGameToolDefinitions(
        new MemoryProjectEnvironmentPort(),
        capabilitySet(),
        { includedToolNames: [] },
      ),
    ).toThrow(/must not be empty/u);
    expect(() =>
      createProjectEnvironmentGameToolDefinitions(
        new MemoryProjectEnvironmentPort(),
        capabilitySet(),
        {
          queryInputProfile: "future-profile",
        } as never,
      ),
    ).toThrow(/Unknown game_query input profile/u);
  });

  it("returns budget_exhausted for the first over-budget game call without invoking the runtime", async () => {
    const port = new MemoryProjectEnvironmentPort();
    const admission = createProjectEnvironmentToolCallAdmissionV1(1);
    const status = createProjectEnvironmentGameToolDefinitions(
      port,
      capabilitySet(),
      { toolCallAdmission: admission },
    ).find((tool) => tool.name === "game_status");
    if (status === undefined) throw new Error("missing game_status tool");
    const input = {
      schemaVersion: 1,
      taskId: "task:pe-a",
      runtimeId: "runtime:pe-a",
    };

    await status.execute(
      "call:first",
      input,
      undefined,
      undefined,
      {} as never,
    );
    const rejected = await status.execute(
      "call:rejected",
      input,
      undefined,
      undefined,
      {} as never,
    );

    expect(port.requests).toHaveLength(1);
    expect(rejected.details).toEqual({
      schemaVersion: 1,
      toolCallId: "call:rejected",
      outcome: "error",
      error: {
        code: "budget_exhausted",
        message:
          "Project Environment turn tool-call budget exhausted after 1 admitted call(s)",
        recoverable: false,
      },
    });
    expect(admission).toMatchObject({
      admitted: 1,
      rejected: 1,
      attempted: 2,
      exhausted: true,
    });
  });

  it("returns structured unsupported_capability without invoking the port", async () => {
    const port = new MemoryProjectEnvironmentPort();
    const result = await execute(port, capabilitySet(), "game_input", {
      schemaVersion: 1,
      taskId: "task:pe-a",
      runtimeId: "runtime:pe-a",
      controlId: "player.move",
      requested: {
        clockDomain: "process_frame",
        position: 1,
        phase: "process_frame_end",
      },
    });
    expect(port.requests).toEqual([]);
    expect(result.details).toMatchObject({
      outcome: "error",
      error: {
        code: "unsupported_capability",
        recoverable: false,
        details: {
          schemaVersion: 1,
          module: "input_control",
          status: "unsupported",
        },
      },
    });
  });

  it("invokes degraded modules and leaves alignment advisory for descriptive compare", async () => {
    const port = new MemoryProjectEnvironmentPort();
    await execute(
      port,
      capabilitySet({ input_control: "degraded" }),
      "game_input",
      {
        schemaVersion: 1,
        taskId: "task:pe-a",
        runtimeId: "runtime:pe-a",
        controlId: "player.move",
        requested: {
          clockDomain: "process_frame",
          position: 1,
          phase: "process_frame_end",
        },
      },
    );
    await execute(port, capabilitySet(), "game_compare", {
      schemaVersion: 1,
      taskId: "task:pe-a",
      baselineExecutionId: "execution:baseline",
      candidateExecutionId: "execution:candidate",
      maxDifferences: 20,
    });
    expect(port.requests.map((request) => request.toolName)).toEqual([
      "game_input",
      "game_compare",
    ]);
  });

  it("validates strict input before port invocation", async () => {
    const port = new MemoryProjectEnvironmentPort();
    await expect(
      execute(port, capabilitySet(), "game_status", {
        schemaVersion: 1,
        taskId: "task:pe-a",
        runtimeId: "runtime:pe-a",
        path: "/host/runtime",
      }),
    ).rejects.toThrow(/Invalid input/u);
    expect(port.requests).toEqual([]);
  });

  it("validates the exact success schema and canonical projections", async () => {
    const port = new MemoryProjectEnvironmentPort();
    port.response = {
      schemaVersion: 1,
      toolCallId: "call:pe-a",
      outcome: "success",
      output: {
        schemaVersion: 1,
        taskId: "task:pe-a",
        executionId: "execution:pe-a",
        rows: [
          {
            schemaVersion: 1,
            rowId: "row:1",
            kind: "state",
            clock: null,
            value: { health: 10 },
          },
        ],
        nextCursor: null,
        coverage: [],
        loss: [],
        limitations: [],
      },
    };
    const result = await execute(port, capabilitySet(), "game_query", {
      schemaVersion: 1,
      taskId: "task:pe-a",
      executionId: "execution:pe-a",
      select: "state",
      limit: 20,
    });
    expect(result.details).toMatchObject({ outcome: "success" });

    port.response = {
      ...(port.response as Record<string, unknown>),
      output: {
        ...(
          port.response as {
            readonly output: Record<string, unknown>;
          }
        ).output,
        rows: [
          {
            schemaVersion: 1,
            rowId: "row:1",
            kind: "state",
            clock: null,
            value: -0,
          },
        ],
      },
    };
    await expect(
      execute(port, capabilitySet(), "game_query", {
        schemaVersion: 1,
        taskId: "task:pe-a",
        executionId: "execution:pe-a",
        select: "state",
        limit: 20,
      }),
    ).rejects.toThrow(/Invalid Project Environment success output/u);

    const cyclic: { child?: unknown } = {};
    cyclic.child = cyclic;
    port.response = {
      ...(port.response as Record<string, unknown>),
      output: {
        ...(
          port.response as {
            readonly output: Record<string, unknown>;
          }
        ).output,
        rows: [
          {
            schemaVersion: 1,
            rowId: "row:1",
            kind: "state",
            clock: null,
            value: cyclic,
          },
        ],
      },
    };
    await expect(
      execute(port, capabilitySet(), "game_query", {
        schemaVersion: 1,
        taskId: "task:pe-a",
        executionId: "execution:pe-a",
        select: "state",
        limit: 20,
      }),
    ).rejects.toThrow(/Invalid Project Environment success output/u);
  });

  it("rejects malformed capability sets and invalid helper requests", () => {
    expect(() =>
      createProjectEnvironmentGameToolDefinitions(
        new MemoryProjectEnvironmentPort(),
        {
          schemaVersion: 1,
          modules: capabilitySet().modules.slice(1),
        } as ProjectCapabilitySetV1,
      ),
    ).toThrow(/modules/u);
    const unsupported = capabilitySet().modules.find(
      (module) => module.module === "snapshot",
    );
    if (unsupported === undefined) throw new Error("missing snapshot module");
    expect(() =>
      projectEnvironmentUnsupportedCapabilityResponseV1(
        "call:pe-a",
        "restore",
        unsupported,
      ),
    ).toThrow(/matching unavailable module/u);
  });
});
