import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  DefaultResourceLoader,
  initTheme,
  InteractiveMode,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionServices,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { PiThinkingLevel } from "./types.js";
import { configureVNextPiHostHttpTransport } from "./vnext-host-http.js";
import {
  finalAssistantFailure,
  resolvePiHostAgentDirectory,
  snapshotPiSession,
  type VNextPiTurnResult,
  VNEXT_CODING_ENVIRONMENT_APPENDIX,
} from "./vnext-session.js";
import {
  abortPiSession,
  rootPiSessionControl,
  type RootCollaborationPort,
  type RootPiSessionControl,
} from "./root-collaboration.js";
import {
  assertRootCollaborationExtensions,
  createRootCollaborationExtension,
} from "./root-collaboration-extension.js";

export interface RunProjectEnvironmentInteractivePiSessionV1Options {
  readonly resourceWorkspaceDirectory: string;
  readonly sessionDirectory: string;
  /** Existing Session file, or omitted to create the pinned Task Session. */
  readonly sessionFile?: string | undefined;
  readonly expectedSessionId: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: PiThinkingLevel;
  readonly tools: readonly ToolDefinition[];
  readonly additionalEnvironmentInstructions: string;
  readonly agentDir?: string | undefined;
  readonly collaboration?: RootCollaborationPort | undefined;
  /** Pi's real TUI exits the process; Host finalization must run in this hook. */
  readonly onShutdown?:
    ((result: VNextPiTurnResult) => Promise<void>) | undefined;
}

/**
 * Runs Pi's official TUI while keeping the exact Project Environment Session,
 * model, resources, and Host-defined tools. Session-switch commands are
 * rebound to the pinned Session instead of adopting another cwd or tool set.
 */
export async function runProjectEnvironmentInteractivePiSessionV1(
  options: RunProjectEnvironmentInteractivePiSessionV1Options,
): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Project Environment interactive mode requires a TTY");
  }
  if (options.tools.length === 0) {
    throw new Error("Project Environment TUI requires at least one tool");
  }
  const toolNames = options.tools.map((tool) => tool.name);
  if (new Set(toolNames).size !== toolNames.length) {
    throw new Error("Project Environment TUI tools must have unique names");
  }
  configureVNextPiHostHttpTransport();
  const agentDir = resolvePiHostAgentDirectory(options.agentDir);
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const model = modelRuntime.getModel(options.provider, options.model);
  if (model === undefined) {
    throw new Error(
      `Pi model ${options.provider}/${options.model} is not registered`,
    );
  }
  const available = await modelRuntime.getAvailable(options.provider);
  if (!available.some((candidate) => candidate.id === options.model)) {
    throw new Error(
      `Pi model ${options.provider}/${options.model} has no usable Host authentication`,
    );
  }

  const resourceWorkspaceDirectory = resolve(
    options.resourceWorkspaceDirectory,
  );
  const sessionDirectory = resolve(options.sessionDirectory);
  let sessionFile =
    options.sessionFile === undefined
      ? undefined
      : resolve(options.sessionFile);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
  });
  const collaboration = options.collaboration;
  let activeSession: AgentSession | undefined;
  let eventsObserved = 0;
  let preparingPrompt = false;
  let detachRoot: void | (() => void) = undefined;
  let unsubscribeRoot: (() => void) | undefined;
  let rootControl: RootPiSessionControl | undefined;
  const releaseRoot = (): void => {
    const unsubscribe = unsubscribeRoot;
    const detach = detachRoot;
    unsubscribeRoot = undefined;
    detachRoot = undefined;
    try {
      unsubscribe?.();
    } finally {
      detach?.();
      rootControl?.dispose?.();
      rootControl = undefined;
    }
  };
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    collaboration?.interrupt();
    shutdownPromise = (async () => {
      const cleanup = await Promise.allSettled([
        collaboration?.stopAgents(),
        activeSession === undefined ? undefined : abortPiSession(activeSession),
      ]);
      const errors = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      try {
        if (activeSession !== undefined && options.onShutdown !== undefined) {
          const result = snapshotPiSession(
            activeSession,
            {
              provider: activeSession.model?.provider ?? options.provider,
              model: activeSession.model?.id ?? options.model,
              thinkingLevel: options.thinkingLevel,
              eventsObserved,
            },
            errors.length === 0 ? undefined : "aborted",
            errors.length === 0
              ? undefined
              : `Pi collaboration cleanup failed: ${errors.map(String).join("; ").slice(0, 4096)}`,
          );
          await options.onShutdown(result);
        }
        if (errors.length !== 0)
          throw new AggregateError(errors, "Pi collaboration cleanup failed");
      } finally {
        releaseRoot();
      }
    })();
    return shutdownPromise;
  };
  const resourceLoader = new DefaultResourceLoader({
    cwd: resourceWorkspaceDirectory,
    agentDir,
    settingsManager,
    noExtensions: true,
    additionalExtensionPaths: [],
    ...(collaboration === undefined && options.onShutdown === undefined
      ? {}
      : {
          extensionFactories: [
            createRootCollaborationExtension(
              collaboration,
              async () => {
                preparingPrompt = false;
                if (activeSession !== undefined)
                  await abortPiSession(activeSession);
              },
              (preparing) => {
                preparingPrompt = preparing;
                if (preparing) rootControl?.onUserInput();
              },
              shutdown,
            ),
          ],
        }),
    noThemes: true,
    appendSystemPrompt: [
      VNEXT_CODING_ENVIRONMENT_APPENDIX,
      options.additionalEnvironmentInstructions,
    ],
  });
  await resourceLoader.reload();
  const services: AgentSessionServices = {
    cwd: resourceWorkspaceDirectory,
    agentDir,
    modelRuntime,
    settingsManager,
    resourceLoader,
    diagnostics: [],
  };
  const exactSessionManager = (): SessionManager => {
    const manager =
      sessionFile === undefined
        ? SessionManager.create(resourceWorkspaceDirectory, sessionDirectory, {
            id: options.expectedSessionId,
          })
        : SessionManager.open(
            sessionFile,
            sessionDirectory,
            resourceWorkspaceDirectory,
          );
    if (manager.getSessionId() !== options.expectedSessionId) {
      throw new Error(
        "Pi TUI Session identity does not match the Task binding",
      );
    }
    const realizedFile = manager.getSessionFile();
    if (realizedFile === undefined) {
      throw new Error("Pi TUI did not create a durable Task Session file");
    }
    sessionFile = resolve(realizedFile);
    return manager;
  };
  // Pi writes a fresh SessionManager only after the first assistant message.
  // Keep its in-memory entries across /new and other runtime replacements until
  // that file exists; opening an absent path would create a new Session identity.
  const initialSessionManager = exactSessionManager();
  let retainedSessionManager = initialSessionManager;
  let initialRuntime = true;
  const createRuntime = async () => {
    if (
      !initialRuntime &&
      sessionFile !== undefined &&
      existsSync(sessionFile)
    ) {
      retainedSessionManager = exactSessionManager();
    }
    const sessionManager = retainedSessionManager;
    initialRuntime = false;
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      model,
      thinkingLevel: options.thinkingLevel,
      noTools: "all",
      tools: toolNames,
      customTools: [...options.tools],
    });
    try {
      assertRootCollaborationExtensions(
        created.extensionsResult,
        collaboration !== undefined || options.onShutdown !== undefined,
      );
    } catch (error) {
      created.session.dispose();
      throw error;
    }
    const activeTools = created.session.getActiveToolNames();
    if (
      activeTools.length !== toolNames.length ||
      toolNames.some((name) => !activeTools.includes(name))
    ) {
      created.session.dispose();
      throw new Error(
        "Project Environment TUI activated an unexpected tool set",
      );
    }
    try {
      releaseRoot();
      activeSession = created.session;
      if (collaboration !== undefined) {
        rootControl = rootPiSessionControl(
          created.session,
          () => preparingPrompt,
        );
        detachRoot = collaboration.bindRoot(rootControl);
      }
      unsubscribeRoot = created.session.subscribe((event) => {
        eventsObserved += 1;
        if (event.type !== "agent_settled" || collaboration === undefined)
          return;
        if (finalAssistantFailure(created.session.messages) !== undefined) {
          collaboration.interrupt();
          return;
        }
        // Keep workers alive while the TUI Task remains open. Their ordinary
        // mail is consumed by the next user turn, never an automatic Root turn.
      });
    } catch (error) {
      created.session.dispose();
      if (activeSession === created.session) activeSession = undefined;
      throw error;
    }
    return { ...created, services, diagnostics: [] };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: resourceWorkspaceDirectory,
    agentDir,
    sessionManager: initialSessionManager,
  });
  initTheme(settingsManager.getTheme(), false);
  try {
    await new InteractiveMode(runtime, { verbose: false }).run();
  } finally {
    try {
      await shutdown();
    } finally {
      await runtime.dispose();
    }
  }
  if (sessionFile === undefined) {
    throw new Error("Pi TUI did not retain its durable Task Session file");
  }
  return sessionFile;
}
