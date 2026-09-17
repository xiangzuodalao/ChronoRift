import { createServer, type Socket } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  defineTool,
  ModelRuntime,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import {
  createManagedMcpProbe,
  createManagedPiSession,
  type ManagedMcpEnvironment,
} from "../src/index.js";

it("loads native MCP schemas, validates cold stops and exposes Host waits before the first turn offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "cr-pi-mcp-"));
  const sockets = new Set<Socket>();
  const calls: unknown[] = [];
  const pixel =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      while (buffer.includes("\n")) {
        const offset = buffer.indexOf("\n");
        const request = JSON.parse(buffer.slice(0, offset)) as {
          id?: number;
          method: string;
          params?: unknown;
        };
        buffer = buffer.slice(offset + 1);
        if (request.id === undefined) continue;
        let result: object = {};
        if (request.method === "initialize")
          result = {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "offline", version: "1" },
          };
        if (request.method === "tools/list")
          result = {
            tools: [
              ...["game_manage", "editor_manage", "project_run"].map(
                (name) => ({
                  name,
                  description: `Native ${name}`,
                  inputSchema: {
                    type: "object",
                    properties: {
                      op: { type: "string" },
                      params: { type: "object" },
                    },
                  },
                }),
              ),
              {
                name: "editor_screenshot",
                description: "Capture game pixels",
                inputSchema: {
                  type: "object",
                  properties: { source: { type: "string", enum: ["game"] } },
                  required: ["source"],
                  additionalProperties: false,
                },
              },
              {
                name: "project_manage",
                description: "Manage the project",
                inputSchema: {
                  type: "object",
                  properties: {
                    op: { type: "string", enum: ["stop", "pause"] },
                    params: { type: "object" },
                  },
                  required: ["op"],
                  additionalProperties: false,
                },
              },
            ],
          };
        if (request.method === "tools/call") {
          calls.push(request.params);
          const call = request.params as {
            name: string;
            arguments?: { op?: unknown; params?: unknown };
          };
          result =
            call.name === "project_manage"
              ? {
                  isError: true,
                  content: [
                    { type: "text", text: "Upstream rejected fixture request" },
                  ],
                }
              : {
                  content: [
                    { type: "text", text: "Captured real fixture image" },
                    { type: "image", data: pixel, mimeType: "image/png" },
                  ],
                };
        }
        socket.write(
          JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
        );
      }
    });
  });
  const socketPath = join(root, "mcp.sock");
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  await mkdir(join(root, "agent"));
  // Project-controlled MCP config must not expand Host permissions or tool inventory.
  await writeFile(
    join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        intruder: { command: "/must-not-run", lifecycle: "eager" },
      },
    }),
  );
  const faux = fauxProvider({
    api: "cr-mcp-test",
    provider: "cr-mcp-test",
    models: [{ id: "offline", input: ["text", "image"] }],
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  let raw: AgentSession | undefined;
  const admitted: string[] = [];
  const editorRequirements: boolean[] = [];
  const requests: unknown[] = [];
  const waits: number[] = [];
  let coldStops = 0;
  const environment: ManagedMcpEnvironment = {
    socketPath,
    agentDirectory: join(root, "agent"),
    runTool: async (name, _id, operation, _signal, requiresEditor, request) => {
      admitted.push(name);
      editorRequirements.push(requiresEditor ?? true);
      requests.push(
        request === undefined
          ? null
          : { tool: request.tool, operation: request.operation },
      );
      if (request?.whenEditorStopped !== undefined) {
        coldStops++;
        return request.whenEditorStopped();
      }
      return operation();
    },
    wait: async (_id, durationMs, signal) => {
      if (durationMs === 777) {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("Fixture wait cancelled")),
            {
              once: true,
            },
          );
          if (signal?.aborted) reject(new Error("Fixture wait cancelled"));
        });
      }
      waits.push(durationMs);
      return {
        elapsedMs: durationMs,
        editorState: "stopped",
        editorGeneration: 0,
      };
    },
  };
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    const session = await createManagedPiSession(
      {
        resourceWorkspaceDirectory: root,
        sessionDirectory: join(root, "sessions"),
        agentDir: join(root, "agent"),
        modelRuntime,
        model: modelRuntime.getModel("cr-mcp-test", "offline")!,
        thinkingLevel: "off",
        tools: [
          defineTool({
            name: "read",
            label: "read",
            description: "Fixture read",
            parameters: Type.Object({}),
            execute: async () => ({
              content: [{ type: "text", text: "fixture" }],
              details: {},
            }),
          }),
        ],
        mcpEnvironment: environment,
      },
      {
        createSession: async (options) => {
          const created = await createAgentSession(options);
          raw = created.session;
          return created;
        },
      },
    );
    expect(raw!.getActiveToolNames()).toEqual(
      expect.arrayContaining(["mcp", "read", "environment_wait"]),
    );
    const turns = [
      fauxAssistantMessage(
        fauxToolCall("godot-ai_editor_screenshot", { source: 123 }),
      ),
      fauxAssistantMessage(
        fauxToolCall("godot-ai_editor_screenshot", { source: "game" }),
      ),
      fauxAssistantMessage(
        fauxToolCall("godot-ai_project_manage", { op: "stop" }),
      ),
      fauxAssistantMessage(
        fauxToolCall("mcp", {
          tool: "project_manage",
          server: "godot-ai",
          args: { op: "stop" },
        }),
      ),
      fauxAssistantMessage(
        fauxToolCall("mcp", {
          tool: "godot-ai_project_manage",
          args: '{"op":"stop"}',
        }),
      ),
      fauxAssistantMessage(
        fauxToolCall("mcp", {
          tool: "godot_ai_project_manage",
          args: { op: "stop" },
        }),
      ),
      // Mixed gateway modes retain the adapter's own operation selection.
      fauxAssistantMessage(
        fauxToolCall("mcp", {
          tool: "godot-ai_project_manage",
          args: { op: "stop" },
          search: "screenshot",
        }),
      ),
      // Unqualified names without a server are not valid adapter targets.
      fauxAssistantMessage(
        fauxToolCall("mcp", {
          tool: "project_manage",
          args: { op: "stop" },
        }),
      ),
      fauxAssistantMessage(
        fauxToolCall("godot-ai_project_manage", { op: "invalid" }),
      ),
      fauxAssistantMessage(
        fauxToolCall("mcp", {
          tool: "godot-ai_project_manage",
          args: { op: "stop", params: "invalid" },
        }),
      ),
      fauxAssistantMessage(
        fauxToolCall("mcp", {
          tool: "project_manage",
          args: "{invalid",
        }),
      ),
      fauxAssistantMessage(fauxToolCall("mcp", { search: "screenshot" })),
      fauxAssistantMessage(
        fauxToolCall("environment_wait", { duration_ms: 10_001 }),
      ),
      fauxAssistantMessage(
        fauxToolCall("environment_wait", { duration_ms: 1.5 }),
      ),
      fauxAssistantMessage(
        fauxToolCall("environment_wait", { duration_ms: 0 }),
      ),
      fauxAssistantMessage(
        fauxToolCall("environment_wait", { duration_ms: 13 }),
      ),
      fauxAssistantMessage(
        fauxToolCall("mcp", {
          action: "install",
          url: "https://invalid.example/mcp",
        }),
      ),
      fauxAssistantMessage("Done."),
    ];
    let firstSystemPrompt: string | undefined;
    let firstRequestTools: string[] = [];
    faux.setResponses([
      (context) => {
        firstSystemPrompt = context.systemPrompt;
        firstRequestTools = context.tools?.map((tool) => tool.name) ?? [];
        return turns[0]!;
      },
      ...turns.slice(1),
    ]);
    await session.prompt("Capture game screenshot.");
    expect(firstRequestTools).toEqual(
      expect.arrayContaining([
        "mcp",
        "environment_wait",
        "godot-ai_editor_screenshot",
        "godot-ai_project_manage",
        "godot-ai_game_manage",
        "godot-ai_editor_manage",
        "godot-ai_project_run",
      ]),
    );
    // Verify that native tool metadata reaches the first actual SDK model turn.
    for (const note of [
      "autoloads need explicit '/root/<name>' paths",
      "input_sequence schedules Input actions on process frames, not physics ticks",
      "8-second timeout for awaited work",
      "check the actual sample count and values",
      "get_viewport().get_visible_rect().size",
      "A live helper does not prove the target scene or controls are ready",
    ])
      expect(firstSystemPrompt).toContain(note);
    expect(calls, JSON.stringify(raw!.state.messages)).toHaveLength(3);
    expect(admitted).toEqual([
      "godot-ai_editor_screenshot",
      "godot-ai_project_manage",
      "mcp",
      "mcp",
      "mcp",
      "mcp",
      "mcp",
      "mcp",
      "mcp",
      "mcp",
    ]);
    expect(editorRequirements).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(requests).toEqual([
      { tool: "editor_screenshot", operation: undefined },
      { tool: "project_manage", operation: "stop" },
      { tool: "project_manage", operation: "stop" },
      { tool: "project_manage", operation: "stop" },
      { tool: "project_manage", operation: "stop" },
      { tool: "project_manage", operation: "stop" },
      { tool: "project_manage", operation: "stop" },
      { tool: "project_manage", operation: "stop" },
      { tool: "project_manage", operation: undefined },
      null,
    ]);
    expect(coldStops).toBe(4);
    expect(waits).toEqual([0, 13]);
    expect(raw!.getActiveToolNames()).toContain("godot-ai_editor_screenshot");
    expect(JSON.stringify(raw!.state.messages)).toContain(pixel);
    const results = raw!.state.messages.filter(
      (message) => message.role === "toolResult",
    );
    // Bad native arguments are rejected before lifecycle admission/editor startup.
    expect(results[0]?.isError).toBe(true);
    expect(JSON.stringify(results)).toContain('"alreadyStopped":true');
    expect(JSON.stringify(results)).toContain(
      "Upstream rejected fixture request",
    );
    expect(JSON.stringify(results)).toContain("Invalid args JSON");
    expect(JSON.stringify(results)).toContain('"error":"tool_not_found"');
    expect(results.at(-1)?.isError).toBe(true);
    expect(JSON.stringify(results.at(-1))).toContain(
      "install/auth actions are unavailable",
    );
    await session.shutdownExtensions?.();
    expect(process.env.PI_CODING_AGENT_DIR).toBe(previous);
    await raw!.bindExtensions({});
    expect(process.env.PI_CODING_AGENT_DIR).toBe(join(root, "agent"));
    await session.shutdownExtensions?.();
    expect(process.env.PI_CODING_AGENT_DIR).toBe(previous);
    session.dispose();
    const expectedCalls = [...calls];
    const expectedAdmissions = [...admitted];
    const expectedEditorRequirements = [...editorRequirements];
    const probeAgentDir = join(root, "probe-agent");
    await mkdir(probeAgentDir);
    // The probe must use its in-memory credentials/model configuration.
    await writeFile(
      join(probeAgentDir, "auth.json"),
      "not a credential document",
    );
    await writeFile(join(probeAgentDir, "models.json"), "not a model document");
    const stream = vi.spyOn(ModelRuntime.prototype, "streamSimple");
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Probe network is forbidden"));
    const probe = await createManagedMcpProbe({
      resourceWorkspaceDirectory: root,
      mcpEnvironment: { ...environment, agentDirectory: probeAgentDir },
    });
    try {
      const catalog = await probe.execute({
        id: "catalog",
        name: "mcp",
        args: { search: "screenshot" },
      });
      expect(catalog.isError).toBe(false);
      const probeAdmissionStart = admitted.length;
      const probeEditorRequirementStart = editorRequirements.length;
      expect(probe.tools().map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["mcp", "environment_wait"]),
      );
      expect(probe.tools().some((tool) => tool.name === "bash")).toBe(false);
      const probeResults = [];
      for (const turn of turns) {
        for (const block of turn.content) {
          if (block.type !== "toolCall") continue;
          probeResults.push(
            await probe.execute({
              id: block.id,
              name: block.name,
              args: block.arguments,
            }),
          );
        }
      }
      expect(calls.slice(expectedCalls.length)).toEqual(expectedCalls);
      expect(admitted.slice(probeAdmissionStart)).toEqual(expectedAdmissions);
      expect(editorRequirements.slice(probeEditorRequirementStart)).toEqual(
        expectedEditorRequirements,
      );
      expect(probeResults.map((result) => result.isError)).toEqual(
        results.map((result) => result.isError),
      );
      expect(probeResults[1]?.content).toEqual(results[1]?.content);
      expect(JSON.stringify(probeResults)).toContain('"alreadyStopped":true');
      expect(JSON.stringify(probeResults)).toContain('"error":"tool_error"');
      const abort = new AbortController();
      abort.abort();
      const beforeAbort = admitted.length;
      expect(
        (
          await probe.execute({
            id: "aborted",
            name: "godot-ai_project_run",
            args: {},
            signal: abort.signal,
          })
        ).isError,
      ).toBe(true);
      expect(admitted).toHaveLength(beforeAbort);
      const pending = probe.execute({
        id: "pending-wait",
        name: "environment_wait",
        args: { duration_ms: 777 },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await probe.close();
      expect((await pending).isError).toBe(true);
      await probe.close();
      await expect(
        probe.execute({ id: "closed", name: "mcp", args: {} }),
      ).rejects.toThrow("closed");
      expect(stream).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(process.env.PI_CODING_AGENT_DIR).toBe(previous);
    } finally {
      await probe.close();
      stream.mockRestore();
      fetch.mockRestore();
    }
    // A loaded extension factory must release its directory if the SDK fails
    // before it returns a Session/ExtensionRunner.
    await expect(
      createManagedPiSession(
        {
          resourceWorkspaceDirectory: root,
          sessionDirectory: join(root, "failed-sessions"),
          agentDir: join(root, "failed-agent"),
          modelRuntime,
          model: modelRuntime.getModel("cr-mcp-test", "offline")!,
          thinkingLevel: "off",
          tools: [
            defineTool({
              name: "fixture",
              label: "fixture",
              description: "fixture",
              parameters: Type.Object({}),
              execute: async () => ({ content: [], details: {} }),
            }),
          ],
          mcpEnvironment: {
            ...environment,
            agentDirectory: join(root, "failed-agent"),
          },
        },
        {
          createSession: async () => {
            throw new Error("SDK construction failed");
          },
        },
      ),
    ).rejects.toThrow("SDK construction failed");
    // Give the adapter's load-time setImmediate a chance to run after failure.
    // Shutdown must invalidate that work before it can connect.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect([...sockets].filter((socket) => !socket.destroyed)).toHaveLength(0);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(previous);
    const next = await createManagedMcpProbe({
      resourceWorkspaceDirectory: root,
      mcpEnvironment: environment,
    });
    await next.close();
    expect(process.env.PI_CODING_AGENT_DIR).toBe(previous);
  } finally {
    raw?.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
