import { createJiti } from "jiti";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { McpAdapterOptions } from "pi-mcp-adapter/types";
import type {
  AgentToolResult,
  InlineExtension,
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export const MCP_EXTENSION_NAME = "chronorift-mcp";
const DIRECT_TOOLS = [
  "editor_state",
  "project_run",
  "project_manage",
  "game_manage",
  "editor_manage",
  "editor_screenshot",
  "script_patch",
  "logs_read",
  "scene_open",
];
export const MANAGED_MCP_TOOL_NAMES = [
  "mcp",
  "environment_wait",
  ...DIRECT_TOOLS.map((name) => `godot-ai_${name}`),
];
let activeDirectory: string | undefined;
const WAIT_PARAMETERS = Type.Object(
  { duration_ms: Type.Integer({ minimum: 0, maximum: 10_000 }) },
  { additionalProperties: false },
);

export interface ManagedMcpToolRequest<T> {
  readonly tool: string;
  readonly operation?: string;
  /** Supplied only for a schema-valid, argument-free stop operation. */
  readonly whenEditorStopped?: () => T;
}

export interface ManagedMcpWaitResult {
  readonly elapsedMs: number;
  readonly editorState: "stopped" | "starting" | "ready" | "failed";
  readonly editorGeneration: number;
}

/** Host-owned runtime; the installed adapter owns MCP discovery and content. */
export interface ManagedMcpEnvironment {
  readonly socketPath: string;
  readonly agentDirectory: string;
  runTool<T>(
    name: string,
    id: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
    requiresEditor?: boolean,
    request?: ManagedMcpToolRequest<T>,
  ): Promise<T>;
  wait(
    id: string,
    durationMs: number,
    signal?: AbortSignal,
  ): Promise<ManagedMcpWaitResult>;
}

export function createManagedMcpExtension(
  environment: ManagedMcpEnvironment,
): InlineExtension {
  return {
    name: MCP_EXTENSION_NAME,
    async factory(pi) {
      const { createMcpAdapter } = await createJiti(import.meta.url).import<{
        createMcpAdapter: (
          options: McpAdapterOptions,
        ) => (api: ExtensionAPI) => void;
      }>(import.meta.resolve("pi-mcp-adapter"));
      // The adapter resolves cache paths through this variable. The Host passes
      // explicit auth/model paths to Pi; sandboxed processes never inherit it.
      const previous = process.env.PI_CODING_AGENT_DIR;
      const activateDirectory = () => {
        if (
          activeDirectory !== undefined &&
          activeDirectory !== environment.agentDirectory
        )
          throw new Error(
            "Only one managed MCP Root may run in a Host process",
          );
        activeDirectory = environment.agentDirectory;
        process.env.PI_CODING_AGENT_DIR = environment.agentDirectory;
      };
      const restoreDirectory = () => {
        if (activeDirectory === environment.agentDirectory)
          activeDirectory = undefined;
        if (process.env.PI_CODING_AGENT_DIR === environment.agentDirectory) {
          if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
          else process.env.PI_CODING_AGENT_DIR = previous;
        }
      };
      activateDirectory();
      // Pi reuses extension instances across /new and Session replacement.
      pi.on("session_start", activateDirectory);
      const adapter = createMcpAdapter({
        config: {
          mcpServers: {
            "godot-ai": {
              socket: environment.socketPath,
              lifecycle: "eager",
              // Pi 0.84.1 snapshots executable tools at the start of a turn.
              // Register common schemas before that snapshot, not during search.
              directTools: DIRECT_TOOLS,
              requestTimeoutMs: 60_000,
            },
          },
          settings: {
            scriptMode: false,
            sampling: false,
            elicitation: false,
            autoAuth: false,
            idleTimeout: 0,
          },
        },
      });
      const nativeSchemas = new Map<string, ToolDefinition["parameters"]>();
      const registerTool: ExtensionAPI["registerTool"] = (registeredTool) => {
        // Adapter results are opaque here. Widen only its details type at this
        // registration boundary so a Host receipt can use its own namespace.
        const tool = registeredTool as ToolDefinition;
        if (tool.name.startsWith("godot-ai_"))
          nativeSchemas.set(
            tool.name.slice("godot-ai_".length),
            tool.parameters,
          );
        pi.registerTool({
          ...tool,
          executionMode: "sequential",
          execute: (id, input, signal, onUpdate, context) => {
            const params = input as Record<string, unknown>;
            if (tool.name === "mcp") {
              if (
                params.action !== undefined ||
                params.url !== undefined ||
                params.target !== undefined
              )
                throw new Error(
                  "ChronoRift manages the MCP server; install/auth actions are unavailable",
                );
              for (const key of ["server", "connect", "instructions"]) {
                if (params[key] !== undefined && params[key] !== "godot-ai")
                  throw new Error(
                    "Only the managed godot-ai MCP server is available",
                  );
              }
            }
            const target = tool.name === "mcp" ? params.tool : tool.name;
            const nativeName =
              typeof target === "string"
                ? target.replace(/^godot[-_]ai_/, "")
                : undefined;
            // The gateway owns argument parsing and errors. Parse only enough
            // to identify the strictly schema-validated cold-stop fast path.
            let args: unknown = tool.name === "mcp" ? params.args : input;
            if (tool.name === "mcp" && typeof args === "string") {
              try {
                args = JSON.parse(args);
              } catch {
                args = undefined;
              }
            }
            const objectArgs =
              args !== null && typeof args === "object" && !Array.isArray(args)
                ? (args as Record<string, unknown>)
                : undefined;
            const nativeSchema = nativeName && nativeSchemas.get(nativeName);
            const canStopClosedEditor =
              nativeName === "project_manage" &&
              (tool.name !== "mcp" ||
                target === "godot-ai_project_manage" ||
                target === "godot_ai_project_manage" ||
                params.server === "godot-ai") &&
              (tool.name !== "mcp" ||
                Object.keys(params).every((key) =>
                  ["tool", "args", "server"].includes(key),
                )) &&
              objectArgs?.op === "stop" &&
              Object.keys(objectArgs).length === 1 &&
              nativeSchema !== undefined &&
              Check(nativeSchema, objectArgs);
            return environment.runTool<AgentToolResult<unknown>>(
              tool.name,
              id,
              () => tool.execute(id, input, signal, onUpdate, context),
              signal,
              tool.name !== "mcp" || params.tool !== undefined,
              nativeName === undefined
                ? undefined
                : {
                    tool: nativeName,
                    ...(typeof objectArgs?.op === "string"
                      ? { operation: objectArgs.op }
                      : {}),
                    ...(canStopClosedEditor
                      ? {
                          whenEditorStopped: () => ({
                            content: [
                              {
                                type: "text" as const,
                                text: "ChronoRift Host: the editor and game are already stopped. No Godot operation or editor startup was performed.",
                              },
                            ],
                            details: {
                              chronorift: {
                                source: "host",
                                editorState: "stopped",
                                operation: "stop",
                                alreadyStopped: true,
                              },
                            },
                          }),
                        }
                      : {}),
                  },
            );
          },
        });
      };
      try {
        adapter({ ...pi, registerTool, registerCommand: () => undefined });
        pi.registerTool({
          name: "environment_wait",
          label: "Wait for environment",
          description:
            "Wait on the Host without closing or starting the Godot editor or game. Use duration_ms=0 to inspect Host-known editor state. Does not observe game readiness or count simulation frames.",
          promptSnippet: "Wait without restarting the Godot environment",
          promptGuidelines: [
            "Use environment_wait to wait while playing; bash closes the game and editor even for sleep or read-only shell commands.",
            "For GUI keyboard input use game_manage input_key; input_action changes action state and does not deliver a GUI key event.",
            "Treat stale screenshot markers and input delivery receipts literally; they do not prove a current frame or successful interaction.",
          ],
          parameters: WAIT_PARAMETERS,
          prepareArguments: (input) => {
            // Pi converts numeric input before regular schema validation,
            // including truncating fractions. Reject invalid raw input first.
            if (!Check(WAIT_PARAMETERS, input))
              throw new Error("duration_ms must be an integer from 0 to 10000");
            return input;
          },
          executionMode: "sequential",
          execute: async (id, input, signal) => {
            const result = await environment.wait(
              id,
              input.duration_ms,
              signal,
            );
            return {
              content: [
                {
                  type: "text",
                  text: `Host waited ${result.elapsedMs} ms. Editor: ${result.editorState}; editor generation: ${result.editorGeneration}. Game readiness and simulation progress were not observed.`,
                },
              ],
              details: { chronorift: result },
            };
          },
        });
      } catch (error) {
        restoreDirectory();
        throw error;
      }
      pi.on("session_shutdown", restoreDirectory);
      // Explicit tool selection in the SDK does not activate extension tools.
      pi.on("session_start", () => {
        pi.setActiveTools([
          ...new Set([...pi.getActiveTools(), "mcp", "environment_wait"]),
        ]);
      });
    },
  };
}
