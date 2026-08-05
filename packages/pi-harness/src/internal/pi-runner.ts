import { join } from "node:path";

import {
  InMemoryCredentialStore,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { PiHarnessError } from "../errors.js";
import type {
  AssertPiModelCapabilitiesOptions,
  AvailablePiModel,
  DeterministicPiHarnessOptions,
  ListAvailablePiModelsOptions,
  PersistPiApiKeyOptions,
  PersistPiApiKeyResult,
  PiDiagnosisRunResult,
  PiHarnessOptions,
  PiThinkingLevel,
} from "../types.js";
import { expectNonEmptyString } from "./contracts.js";
import {
  createDeterministicFauxProvider,
  DETERMINISTIC_PI_MODEL,
  DETERMINISTIC_PI_PROVIDER,
} from "./faux-model.js";
import { createPiTools, PI_TOOL_NAMES } from "./pi-tools.js";
import {
  buildInvestigationPrompt,
  buildSystemPrompt,
} from "./system-prompt.js";
import { HarnessToolFlow } from "./tool-flow.js";

const BUILTIN_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

interface InjectedPiRuntime {
  readonly modelRuntime: ModelRuntime;
  readonly model: Model<Api>;
}

interface SessionRunOptions extends DeterministicPiHarnessOptions {
  readonly thinkingLevel?: PiThinkingLevel;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeThinkingLevel(value: string): PiThinkingLevel {
  if (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  ) {
    return value;
  }
  throw new PiHarnessError(
    "AGENT_FAILED",
    `Pi returned an unsupported thinking level: ${value}`,
  );
}

async function createProductionModelRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({ allowModelNetwork: false });
}

export async function listAvailablePiModelsWithSdk(
  options: ListAvailablePiModelsOptions,
): Promise<readonly AvailablePiModel[]> {
  const modelRuntime = await createProductionModelRuntime();
  const models = await modelRuntime.getAvailable(options.provider);
  return models
    .map((model): AvailablePiModel => ({
      provider: model.provider,
      model: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input.map((input) => String(input)),
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      thinkingLevelMap: { ...model.thinkingLevelMap },
    }))
    .sort((left, right) =>
      `${left.provider}/${left.model}`.localeCompare(
        `${right.provider}/${right.model}`,
      ),
    );
}

export async function assertPiModelCapabilitiesWithSdk(
  options: AssertPiModelCapabilitiesOptions,
): Promise<AvailablePiModel> {
  const models = await listAvailablePiModelsWithSdk({
    provider: options.provider,
  });
  const model = models.find(
    (candidate) =>
      candidate.provider === options.provider &&
      candidate.model === options.model,
  );
  if (model === undefined) {
    throw new PiHarnessError(
      "MODEL_UNAVAILABLE",
      `Pi model ${options.provider}/${options.model} is unavailable or unauthenticated`,
    );
  }
  const mapped = model.thinkingLevelMap[options.thinkingLevel];
  if (
    model.contextWindow !== options.contextWindow ||
    model.maxTokens !== options.maxTokens ||
    mapped !== options.mappedThinkingValue
  ) {
    throw new PiHarnessError(
      "MODEL_CONFIGURATION",
      `Pi model metadata mismatch for ${options.provider}/${options.model}: contextWindow=${model.contextWindow}, maxTokens=${model.maxTokens}, ${options.thinkingLevel}=${String(mapped)}`,
    );
  }
  return model;
}

export async function persistPiApiKeyWithSdk(
  options: PersistPiApiKeyOptions,
): Promise<PersistPiApiKeyResult> {
  const provider = expectNonEmptyString(options.provider, "provider");
  const apiKey = expectNonEmptyString(options.apiKey, "apiKey");

  try {
    const modelRuntime = await createProductionModelRuntime();
    if (modelRuntime.getProvider(provider) === undefined) {
      throw new PiHarnessError(
        "AUTH_FAILED",
        `Pi provider ${provider} is not registered.`,
      );
    }

    let keyRequested = false;
    await modelRuntime.login(provider, "api_key", {
      prompt(prompt) {
        if (keyRequested || prompt.type !== "secret") {
          throw new PiHarnessError(
            "AUTH_FAILED",
            `Pi provider ${provider} requested an unexpected authentication prompt.`,
          );
        }
        keyRequested = true;
        return Promise.resolve(apiKey);
      },
      notify() {},
    });

    const persisted = (await modelRuntime.listCredentials()).some(
      (credential) =>
        credential.providerId === provider && credential.type === "api_key",
    );
    if (!keyRequested || !persisted) {
      throw new PiHarnessError(
        "AUTH_FAILED",
        `Pi did not persist an API key credential for ${provider}.`,
      );
    }

    return { provider, credentialType: "api_key" };
  } catch (error) {
    if (error instanceof PiHarnessError) throw error;
    throw new PiHarnessError(
      "AUTH_FAILED",
      `Pi could not persist credentials for ${provider}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

/** Shared real Pi Session/Agent Loop runner used by production and faux models. */
export async function runPiDiagnosisWithRuntime(
  options: SessionRunOptions,
  runtime: InjectedPiRuntime,
): Promise<PiDiagnosisRunResult> {
  const initialCapsuleId = expectNonEmptyString(
    options.initialCapsuleId,
    "initialCapsuleId",
  );
  expectNonEmptyString(options.cwd, "cwd");
  expectNonEmptyString(options.runDir, "runDir");

  try {
    const flow = new HarnessToolFlow(options.game, initialCapsuleId);
    const customTools = createPiTools(flow);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: getAgentDir(),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () =>
        buildSystemPrompt(options.additionalInstructions),
    });
    await resourceLoader.reload();

    const sessionManager = SessionManager.create(
      options.cwd,
      join(options.runDir, "pi-sessions"),
    );
    const { session, extensionsResult } = await createAgentSession({
      cwd: options.cwd,
      agentDir: getAgentDir(),
      modelRuntime: runtime.modelRuntime,
      model: runtime.model,
      thinkingLevel: options.thinkingLevel ?? "medium",
      noTools: "all",
      tools: [...PI_TOOL_NAMES],
      excludeTools: [...BUILTIN_TOOL_NAMES],
      customTools,
      resourceLoader,
      sessionManager,
      settingsManager,
    });

    try {
      if (extensionsResult.extensions.length !== 0) {
        throw new PiHarnessError(
          "AGENT_FAILED",
          "The isolated Pi resource loader unexpectedly loaded extensions",
        );
      }
      if (extensionsResult.errors.length !== 0) {
        throw new PiHarnessError(
          "AGENT_FAILED",
          `The isolated Pi resource loader reported errors: ${extensionsResult.errors
            .map((entry) => `${entry.path}: ${entry.error}`)
            .join("; ")}`,
        );
      }
      const activeTools = session.getActiveToolNames();
      if (
        activeTools.length !== PI_TOOL_NAMES.length ||
        PI_TOOL_NAMES.some((name) => !activeTools.includes(name)) ||
        BUILTIN_TOOL_NAMES.some((name) => activeTools.includes(name))
      ) {
        throw new PiHarnessError(
          "AGENT_FAILED",
          `Pi activated an unexpected tool set: ${activeTools.join(", ")}`,
        );
      }

      await session.prompt(buildInvestigationPrompt(initialCapsuleId), {
        expandPromptTemplates: false,
      });

      const proposal = flow.getSubmittedProposal();
      if (!proposal) {
        const agentError = session.agent.state.errorMessage;
        throw new PiHarnessError(
          "PROPOSAL_MISSING",
          agentError
            ? `Pi ended without a diagnosis proposal: ${agentError}`
            : "Pi ended without calling submit_diagnosis_proposal",
        );
      }
      const sessionFile = session.sessionFile;
      if (!sessionFile) {
        throw new PiHarnessError(
          "AGENT_FAILED",
          "Pi completed a diagnosis without a persistent session file",
        );
      }
      const stats = session.getSessionStats();

      return {
        proposal,
        piSession: {
          sessionId: session.sessionId,
          sessionFile,
          provider: runtime.model.provider,
          model: runtime.model.id,
          thinkingLevel: normalizeThinkingLevel(session.thinkingLevel),
          stats: {
            toolCalls: stats.toolCalls,
            tokens: {
              input: stats.tokens.input,
              output: stats.tokens.output,
              total: stats.tokens.total,
            },
            cost: stats.cost,
          },
        },
      };
    } finally {
      session.dispose();
    }
  } catch (error) {
    if (error instanceof PiHarnessError) throw error;
    throw new PiHarnessError(
      "AGENT_FAILED",
      `Pi diagnosis failed: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

export async function runPiDiagnosisWithSdk(
  options: PiHarnessOptions,
): Promise<PiDiagnosisRunResult> {
  const provider = expectNonEmptyString(options.provider, "provider");
  const modelId = expectNonEmptyString(options.model, "model");

  try {
    const modelRuntime = await createProductionModelRuntime();
    const model = modelRuntime.getModel(provider, modelId);
    if (!model) {
      const providerModels = modelRuntime
        .getModels(provider)
        .map((candidate) => candidate.id)
        .sort();
      const suffix =
        providerModels.length > 0
          ? ` Available model IDs: ${providerModels.join(", ")}`
          : "";
      throw new PiHarnessError(
        "MODEL_NOT_FOUND",
        `Pi model ${provider}/${modelId} is not registered.${suffix}`,
      );
    }

    const available = await modelRuntime.getAvailable(provider);
    if (!available.some((candidate) => candidate.id === modelId)) {
      const availableIds = available.map((candidate) => candidate.id).sort();
      const suffix =
        availableIds.length > 0
          ? ` Authenticated model IDs: ${availableIds.join(", ")}`
          : " No authenticated models are available for this provider.";
      throw new PiHarnessError(
        "MODEL_UNAVAILABLE",
        `Pi model ${provider}/${modelId} has no usable authentication.${suffix}`,
      );
    }

    return runPiDiagnosisWithRuntime(options, { modelRuntime, model });
  } catch (error) {
    if (error instanceof PiHarnessError) throw error;
    throw new PiHarnessError(
      "AGENT_FAILED",
      `Pi diagnosis failed: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

export async function runDeterministicPiDiagnosisWithSdk(
  options: DeterministicPiHarnessOptions,
): Promise<PiDiagnosisRunResult> {
  const initialCapsuleId = expectNonEmptyString(
    options.initialCapsuleId,
    "initialCapsuleId",
  );
  const faux = createDeterministicFauxProvider(initialCapsuleId);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = modelRuntime.getModel(
    DETERMINISTIC_PI_PROVIDER,
    DETERMINISTIC_PI_MODEL,
  );
  if (!model) {
    throw new PiHarnessError(
      "MODEL_NOT_FOUND",
      "The deterministic faux model was not registered with Pi",
    );
  }

  const result = await runPiDiagnosisWithRuntime(
    { ...options, thinkingLevel: "off" },
    { modelRuntime, model },
  );
  if (faux.getPendingResponseCount() !== 0 || faux.state.callCount !== 5) {
    throw new PiHarnessError(
      "AGENT_FAILED",
      `Deterministic faux response script was not consumed exactly: ${faux.getPendingResponseCount()} pending after ${faux.state.callCount} calls`,
    );
  }
  return result;
}
