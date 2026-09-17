import { createJiti } from "jiti";
import type { McpAdapterOptions } from "pi-mcp-adapter/types";
import type {
  InlineExtension,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

export const MCP_EXTENSION_NAME = "chronorift-mcp";
let activeDirectory: string | undefined;

/** Host-owned runtime; the installed adapter owns MCP discovery and content. */
export interface ManagedMcpEnvironment {
  readonly socketPath: string;
  readonly agentDirectory: string;
  runTool<T>(
    name: string,
    id: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
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
              lifecycle: "lazy",
              directTools: false,
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
      const registerTool: ExtensionAPI["registerTool"] = (tool) => {
        pi.registerTool({
          ...tool,
          executionMode: "sequential",
          execute: (id, input, signal, onUpdate, context) => {
            if (tool.name === "mcp") {
              const params = input as Record<string, unknown>;
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
            return environment.runTool(
              tool.name,
              id,
              () => tool.execute(id, input, signal, onUpdate, context),
              signal,
            );
          },
        });
      };
      try {
        adapter({ ...pi, registerTool, registerCommand: () => undefined });
      } catch (error) {
        restoreDirectory();
        throw error;
      }
      pi.on("session_shutdown", restoreDirectory);
      // Explicit tool selection in the SDK does not activate extension tools.
      pi.on("session_start", () => {
        pi.setActiveTools([...new Set([...pi.getActiveTools(), "mcp"])]);
      });
    },
  };
}
