import { resolve } from "node:path";

import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  DefaultResourceLoader,
  getAgentDir,
  initTheme,
  InteractiveMode,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionServices,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  PROJECT_ADAPTER_SKILL_V1_DIRECTORY,
  PROJECT_ADAPTER_SKILL_V1_NAME,
} from "./project-adapter-skill.js";
import type { PiThinkingLevel } from "./types.js";
import { configureVNextPiHostHttpTransport } from "./vnext-host-http.js";
import {
  VNEXT_ENVIRONMENT_APPENDIX,
  VNEXT_PI_WORKSPACE_CWD,
} from "./vnext-session.js";

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
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
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

  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const sessionDirectory = resolve(options.sessionDirectory);
  let sessionFile =
    options.sessionFile === undefined
      ? undefined
      : resolve(options.sessionFile);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: resolve(options.resourceWorkspaceDirectory),
    agentDir,
    settingsManager,
    noExtensions: true,
    noThemes: true,
    appendSystemPrompt: [
      VNEXT_ENVIRONMENT_APPENDIX,
      options.additionalEnvironmentInstructions,
    ],
    additionalSkillPaths: [PROJECT_ADAPTER_SKILL_V1_DIRECTORY],
  });
  await resourceLoader.reload();
  const loadedSkills = resourceLoader
    .getSkills()
    .skills.filter((skill) => skill.name === PROJECT_ADAPTER_SKILL_V1_NAME);
  if (loadedSkills.length !== 1) {
    throw new Error("Pi TUI did not load the managed ProjectAdapter skill");
  }
  const services: AgentSessionServices = {
    cwd: VNEXT_PI_WORKSPACE_CWD,
    agentDir,
    modelRuntime,
    settingsManager,
    resourceLoader,
    diagnostics: [],
  };
  const exactSessionManager = (): SessionManager => {
    const manager =
      sessionFile === undefined
        ? SessionManager.create(VNEXT_PI_WORKSPACE_CWD, sessionDirectory, {
            id: options.expectedSessionId,
          })
        : SessionManager.open(
            sessionFile,
            sessionDirectory,
            VNEXT_PI_WORKSPACE_CWD,
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
  const createRuntime = async () => {
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: exactSessionManager(),
      model,
      thinkingLevel: options.thinkingLevel,
      noTools: "all",
      tools: toolNames,
      customTools: [...options.tools],
    });
    if (
      created.extensionsResult.extensions.length !== 0 ||
      created.extensionsResult.errors.length !== 0
    ) {
      created.session.dispose();
      throw new Error("Project Environment TUI loaded executable extensions");
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
    return { ...created, services, diagnostics: [] };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: VNEXT_PI_WORKSPACE_CWD,
    agentDir,
    sessionManager: exactSessionManager(),
  });
  initTheme(settingsManager.getTheme(), false);
  try {
    await new InteractiveMode(runtime, { verbose: false }).run();
  } finally {
    await runtime.dispose();
  }
  if (sessionFile === undefined) {
    throw new Error("Pi TUI did not retain its durable Task Session file");
  }
  return sessionFile;
}
