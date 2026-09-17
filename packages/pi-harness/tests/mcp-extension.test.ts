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
import { expect, it } from "vitest";
import { createManagedPiSession } from "../src/index.js";

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
        mcpEnvironment: {
          socketPath,
          agentDirectory: join(root, "agent"),
          runTool: async (
            name,
            _id,
            operation,
            _signal,
            requiresEditor,
            request,
          ) => {
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
          wait: async (_id, durationMs) => {
            waits.push(durationMs);
            return {
              elapsedMs: durationMs,
              editorState: "stopped",
              editorGeneration: 0,
            };
          },
        },
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
    faux.setResponses([
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
    ]);
    await session.prompt("Capture game screenshot.");
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
  } finally {
    raw?.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
