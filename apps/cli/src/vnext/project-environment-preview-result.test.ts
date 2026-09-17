import { describe, expect, it } from "vitest";
import {
  ProjectEnvironmentPreviewResultV2Schema,
  ProjectEnvironmentPreviewResultV4Schema,
  ProjectEnvironmentPreviewResultV5Schema,
  ProjectEnvironmentPreviewResultV6Schema,
} from "./project-environment-preview.js";

const result = (thinkingLevel: unknown) => ({
  schemaVersion: 2,
  status: "completed",
  taskId: "dc2f794d-ea59-46a4-8fbe-ed1380c6e015",
  sessionId: "08c71d8c-5d37-4dfc-8141-b8a6bd86c690",
  sessionFile: "/task/session.jsonl",
  projectRoot: "game",
  sourceSha256: "a".repeat(64),
  candidateSourceChanged: false,
  candidatePatch: null,
  executions: [],
  goalDelivered: true,
  failureCode: null,
  failureMessage: null,
  taskDirectory: "/task",
  workspaceDirectory: "/task/workspace",
  provider: "provider",
  model: "model",
  thinkingLevel,
  limitations: [],
});

describe("inspection Preview result V2", () => {
  it("versions explicit Host budgets and preserves the historical V4 limit", () => {
    const raised = {
      ...result("max"),
      schemaVersion: 5,
      workspaceMode: "shared",
      executionLimits: {
        sharedToolCallLimit: 2048,
        workerTurnTimeoutMs: 2_700_000,
        workerTurnToolCallLimit: 512,
      },
      agents: {
        recordPath: "/task/agents.v2.json",
        count: 0,
        maxAgents: 3,
        sharedToolCalls: 513,
        sharedToolCallLimit: 2048,
      },
    };
    expect(ProjectEnvironmentPreviewResultV5Schema.parse(raised)).toEqual(
      raised,
    );
    const { executionLimits: _limits, ...historical } = raised;
    void _limits;
    expect(
      ProjectEnvironmentPreviewResultV4Schema.safeParse({
        ...historical,
        schemaVersion: 4,
      }).success,
    ).toBe(false);
    expect(
      ProjectEnvironmentPreviewResultV5Schema.safeParse({
        ...raised,
        agents: { ...raised.agents, sharedToolCallLimit: 256 },
      }).success,
    ).toBe(false);
    expect(
      ProjectEnvironmentPreviewResultV5Schema.safeParse({
        ...raised,
        workspaceMode: "single",
      }).success,
    ).toBe(false);
    expect(
      ProjectEnvironmentPreviewResultV5Schema.safeParse({
        ...raised,
        executionLimits: {
          ...raised.executionLimits,
          sharedToolCallLimit: 2049,
        },
      }).success,
    ).toBe(false);
  });
  it("accepts max thinking without changing the result schema version", () => {
    expect(
      ProjectEnvironmentPreviewResultV2Schema.parse(result("max")),
    ).toEqual(result("max"));
  });

  it.each(["ultra", "unknown", "", null, 7])(
    "rejects unsupported thinking level %j",
    (thinkingLevel) => {
      expect(
        ProjectEnvironmentPreviewResultV2Schema.safeParse(result(thinkingLevel))
          .success,
      ).toBe(false);
    },
  );
});

it("distinguishes writable MCP and coding-only results without changing historical contracts", () => {
  const mcp = {
    ...result("max"),
    schemaVersion: 6,
    gameBackend: "godot-ai",
    workspaceMode: "shared-editor",
    agents: null,
    executionLimits: {
      sharedToolCallLimit: 256,
      workerTurnTimeoutMs: 600000,
      workerTurnToolCallLimit: 64,
    },
  };
  expect(ProjectEnvironmentPreviewResultV6Schema.parse(mcp)).toEqual(mcp);
  expect(
    ProjectEnvironmentPreviewResultV6Schema.safeParse({
      ...mcp,
      gameBackend: "none",
    }).success,
  ).toBe(false);
  expect(
    ProjectEnvironmentPreviewResultV6Schema.safeParse({
      ...mcp,
      gameBackend: "none",
      workspaceMode: "coding",
    }).success,
  ).toBe(true);
  expect(
    ProjectEnvironmentPreviewResultV6Schema.safeParse({
      ...mcp,
      agents: {
        recordPath: "/task/agents.json",
        count: 1,
        maxAgents: 3,
        sharedToolCalls: 300,
        sharedToolCallLimit: 256,
      },
    }).success,
  ).toBe(false);
});
