import {
  createAgentSession,
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  type AgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
} from "@earendil-works/pi-coding-agent";
import {
  createManagedMcpExtension,
  MANAGED_MCP_TOOL_NAMES,
  MCP_EXTENSION_NAME,
  type ManagedMcpEnvironment,
} from "./mcp-extension.js";

export interface ManagedSessionBootstrapOptions {
  readonly sdk: Omit<CreateAgentSessionOptions, "resourceLoader"> & {
    readonly cwd: string;
    readonly agentDir: string;
    readonly settingsManager: NonNullable<
      CreateAgentSessionOptions["settingsManager"]
    >;
    readonly sessionManager: NonNullable<
      CreateAgentSessionOptions["sessionManager"]
    >;
    readonly modelRuntime: NonNullable<
      CreateAgentSessionOptions["modelRuntime"]
    >;
  };
  readonly toolNames: readonly string[];
  readonly mcpEnvironment?: ManagedMcpEnvironment | undefined;
  readonly appendSystemPrompt: readonly string[];
}

/** Shared registration and lifecycle for live Sessions and Host-only probes. */
export async function createManagedSessionBootstrap(
  options: ManagedSessionBootstrapOptions,
  createSession: (
    options: CreateAgentSessionOptions,
  ) => Promise<CreateAgentSessionResult> = createAgentSession,
): Promise<{ session: AgentSession; shutdownExtensions: () => Promise<void> }> {
  let releaseFactory: (() => void) | undefined;
  let session: AgentSession | undefined;
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.sdk.cwd,
    agentDir: options.sdk.agentDir,
    settingsManager: options.sdk.settingsManager,
    noExtensions: true,
    extensionFactories:
      options.mcpEnvironment === undefined
        ? []
        : [
            createManagedMcpExtension(options.mcpEnvironment, {
              onFactoryCleanup: (cleanup) => {
                releaseFactory = cleanup;
              },
            }),
          ],
    noThemes: true,
    appendSystemPrompt: [...options.appendSystemPrompt],
  });
  const shutdownExtensions = async (): Promise<void> => {
    try {
      if (options.mcpEnvironment !== undefined) {
        // The eager adapter can schedule initialization during factory loading,
        // before createAgentSession returns. Use Pi's runner for those existing
        // handlers as well, so a failed constructor cannot leave a connection.
        const loaded = resourceLoader.getExtensions();
        const runner =
          session?.extensionRunner ??
          new ExtensionRunner(
            loaded.extensions,
            loaded.runtime,
            options.sdk.cwd,
            options.sdk.sessionManager,
            new ModelRegistry(options.sdk.modelRuntime),
          );
        await runner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
      }
    } finally {
      releaseFactory?.();
    }
  };
  try {
    await resourceLoader.reload();
    const created = await createSession({
      ...options.sdk,
      noTools: "all",
      tools:
        options.mcpEnvironment === undefined
          ? [...options.toolNames]
          : [...options.toolNames, ...MANAGED_MCP_TOOL_NAMES],
      resourceLoader,
    });
    session = created.session;
    const { extensionsResult } = created;
    if (
      extensionsResult.extensions.length !==
        (options.mcpEnvironment === undefined ? 0 : 1) ||
      extensionsResult.extensions.some(
        (extension) => extension.path !== `<inline:${MCP_EXTENSION_NAME}>`,
      )
    )
      throw new Error("vNext Pi session loaded executable extensions");
    if (extensionsResult.errors.length !== 0) {
      throw new Error(
        `vNext Pi extension loading failed: ${extensionsResult.errors.map((entry) => `${entry.path}: ${entry.error}`).join("; ")}`,
      );
    }
    if (options.mcpEnvironment !== undefined) await session.bindExtensions({});
    const activeTools = session.getActiveToolNames();
    if (
      activeTools.some(
        (name) =>
          !options.toolNames.includes(name) &&
          !(
            options.mcpEnvironment !== undefined &&
            MANAGED_MCP_TOOL_NAMES.includes(name)
          ),
      ) ||
      options.toolNames.some((name) => !activeTools.includes(name)) ||
      (options.mcpEnvironment !== undefined &&
        (!activeTools.includes("mcp") ||
          !activeTools.includes("environment_wait")))
    )
      throw new Error(
        `Pi activated an unexpected tool set: ${activeTools.join(", ")}`,
      );
    return { session, shutdownExtensions };
  } catch (error) {
    try {
      await shutdownExtensions();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Managed Pi initialization and cleanup failed",
      );
    } finally {
      session?.dispose();
    }
    throw error;
  }
}
