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

it("loads the pinned Pi MCP extension, discovers tools and preserves image content offline", async () => {
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
                  properties: {},
                  additionalProperties: false,
                },
              },
            ],
          };
        if (request.method === "tools/call") {
          calls.push(request.params);
          result = {
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
          runTool: (name, _id, operation) => {
            admitted.push(name);
            return operation();
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
    expect(raw!.getActiveToolNames().sort()).toEqual(["mcp", "read"]);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("mcp", { search: "screenshot" })),
      fauxAssistantMessage(
        fauxToolCall("mcp", { tool: "godot_ai_editor_screenshot", args: {} }),
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
    expect(calls).toHaveLength(1);
    expect(admitted).toEqual(["mcp", "mcp"]);
    expect(JSON.stringify(raw!.state.messages)).toContain(pixel);
    const results = raw!.state.messages.filter(
      (message) => message.role === "toolResult",
    );
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
