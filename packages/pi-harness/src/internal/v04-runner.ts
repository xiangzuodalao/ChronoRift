import { createHash } from "node:crypto";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  INVESTIGATION_TOOL_DEFINITIONS_V1,
  INVESTIGATION_TOOL_NAMES_V1,
  parseDiagnosisProposalDraftV1,
  parseInvestigationCapabilityManifestV1,
  parseResourceHandleV1,
  type CompareExecutionsInputV1,
  type GetCapsuleInputV1,
  type InvestigationApiV1,
  type InvestigationToolMetadataV1,
  type InvestigationToolNameV1,
  type ListInterventionsInputV1,
  type ReplayExecutionInputV1,
  type RunInterventionInputV1,
  type SourceReadInputV1,
  type SourceSearchInputV1,
} from "@chronorift/agent-protocol";
import {
  DiagnosisProposalV4Schema,
  type DiagnosisProposalV4,
} from "@chronorift/domain";
import {
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Api,
  type Context,
  type FauxResponseStep,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";

import { PiHarnessError, PiProviderFailureError } from "../errors.js";
import type { PiThinkingLevel } from "../types.js";
import type {
  ScriptedV04PiHarnessOptions,
  V04PiDiagnosisRunResult,
  V04PiHarnessOptions,
  V04PiToolCallRecord,
  V04ScriptObservation,
  V04ScriptValue,
} from "../v04-types.js";
import { createPiProviderFailureError } from "./provider-failure.js";
import { buildV04SystemPrompt, buildV04UserPrompt } from "./v04-prompt.js";

const SCRIPTED_PROVIDER = "chronorift-faux";
const SCRIPTED_MODEL = "chronorift-v0.4-scripted";
const BUILTIN_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

type RuntimeOptions = V04PiHarnessOptions | ScriptedV04PiHarnessOptions;
type UnknownRecord = Record<string, unknown>;

const defineSequentialTool = <
  TParams extends TSchema,
  TDetails = unknown,
  TState = unknown,
>(
  tool: ToolDefinition<TParams, TDetails, TState>,
) => defineTool({ ...tool, executionMode: "sequential" });

const jsonContent = (value: unknown) => [
  { type: "text" as const, text: JSON.stringify(value, null, 2) },
];

const toolResult = (value: unknown) => ({
  content: jsonContent(value),
  details: value,
});

const digestText = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const normalizeThinking = (value: string): PiThinkingLevel => {
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
    "MODEL_CONFIGURATION",
    `Unsupported Pi thinking level ${value}`,
  );
};

const metadataByName = new Map(
  INVESTIGATION_TOOL_DEFINITIONS_V1.map((definition) => [
    definition.name,
    definition,
  ]),
);

const toolMetadata = (
  name: InvestigationToolNameV1,
): InvestigationToolMetadataV1 => {
  const metadata = metadataByName.get(name);
  if (metadata === undefined) {
    throw new PiHarnessError(
      "INVALID_ARGUMENT",
      `Unknown investigation tool ${name}`,
    );
  }
  return metadata;
};

const enabledToolDefinitions = (
  api: InvestigationApiV1,
): readonly InvestigationToolMetadataV1[] => {
  const manifest = parseInvestigationCapabilityManifestV1(api.manifest);
  const capabilities = new Set<string>(manifest.capabilities);
  if (!capabilities.has("capsule.read")) {
    throw new PiHarnessError(
      "INVALID_ARGUMENT",
      "A v0.4 investigation must allow capsule.read",
    );
  }
  if (!capabilities.has("proposal.submit")) {
    throw new PiHarnessError(
      "INVALID_ARGUMENT",
      "A v0.4 investigation must allow proposal.submit",
    );
  }
  return INVESTIGATION_TOOL_DEFINITIONS_V1.filter((definition) =>
    capabilities.has(definition.capability),
  );
};

export class V04ToolFlow {
  private proposal: DiagnosisProposalV4 | undefined;
  private readonly calls: V04PiToolCallRecord[] = [];
  private terminal: PiHarnessError | undefined;
  private inFlight = false;

  public constructor(public readonly api: InvestigationApiV1) {
    parseInvestigationCapabilityManifestV1(api.manifest);
  }

  public get terminalError(): PiHarnessError | undefined {
    return this.terminal;
  }

  public async invoke<T>(
    toolName: InvestigationToolNameV1,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.terminal !== undefined) throw this.terminal;
    if (this.inFlight) {
      const error = new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Concurrent v0.4 investigation tool calls are not allowed",
      );
      this.terminal = error;
      throw error;
    }
    const sequence = this.calls.length + 1;
    if (sequence > this.api.manifest.budgets.maxToolCalls) {
      const error = new PiHarnessError(
        "AGENT_BUDGET_EXHAUSTED",
        `V0.4 tool-call budget exhausted before ${toolName}`,
        {
          details: {
            budget: "tool_calls",
            limit: this.api.manifest.budgets.maxToolCalls,
            observed: sequence,
          },
        },
      );
      this.calls.push({ sequence, toolName, status: "failed" });
      this.terminal = error;
      throw error;
    }
    this.inFlight = true;
    try {
      const value = await operation();
      this.calls.push({ sequence, toolName, status: "succeeded" });
      return value;
    } catch (cause) {
      const error =
        cause instanceof PiHarnessError
          ? cause
          : new PiHarnessError(
              "INVALID_TOOL_FLOW",
              `V0.4 investigation tool ${toolName} failed`,
              { cause },
            );
      this.calls.push({ sequence, toolName, status: "failed" });
      this.terminal = error;
      throw error;
    } finally {
      this.inFlight = false;
    }
  }

  public acceptProposal(value: unknown): DiagnosisProposalV4 {
    if (this.proposal !== undefined) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "A v0.4 investigation may submit only one proposal",
      );
    }
    const proposal = DiagnosisProposalV4Schema.parse(value);
    this.proposal = structuredClone(proposal);
    return structuredClone(proposal);
  }

  public getProposal(): DiagnosisProposalV4 | undefined {
    return this.proposal === undefined
      ? undefined
      : structuredClone(this.proposal);
  }

  public getCalls(): readonly V04PiToolCallRecord[] {
    return structuredClone(this.calls);
  }
}

export const createV04Tools = (flow: V04ToolFlow): readonly ToolDefinition[] =>
  enabledToolDefinitions(flow.api).map((metadata) => {
    const execute = async (params: unknown): Promise<unknown> => {
      switch (metadata.name) {
        case INVESTIGATION_TOOL_NAMES_V1.getCapsule:
          return flow.invoke(metadata.name, () =>
            flow.api.getCapsule(params as GetCapsuleInputV1),
          );
        case INVESTIGATION_TOOL_NAMES_V1.replayExecution:
          return flow.invoke(metadata.name, () =>
            flow.api.replayExecution(params as ReplayExecutionInputV1),
          );
        case INVESTIGATION_TOOL_NAMES_V1.listInterventions:
          return flow.invoke(metadata.name, () =>
            flow.api.listInterventions(params as ListInterventionsInputV1),
          );
        case INVESTIGATION_TOOL_NAMES_V1.runIntervention:
          return flow.invoke(metadata.name, () =>
            flow.api.runIntervention(params as RunInterventionInputV1),
          );
        case INVESTIGATION_TOOL_NAMES_V1.compareExecutions:
          return flow.invoke(metadata.name, () =>
            flow.api.compareExecutions(params as CompareExecutionsInputV1),
          );
        case INVESTIGATION_TOOL_NAMES_V1.readSource:
          return flow.invoke(metadata.name, () =>
            flow.api.readSource(params as SourceReadInputV1),
          );
        case INVESTIGATION_TOOL_NAMES_V1.searchSource:
          return flow.invoke(metadata.name, () =>
            flow.api.searchSource(params as SourceSearchInputV1),
          );
        case INVESTIGATION_TOOL_NAMES_V1.submitProposal:
          return flow.invoke(metadata.name, async () => {
            const submitted = await flow.api.submitProposal(
              parseDiagnosisProposalDraftV1(params),
            );
            if (submitted.accepted !== true) {
              throw new PiHarnessError(
                "INVALID_DIAGNOSIS",
                "Investigation API rejected the v0.4 proposal",
              );
            }
            parseResourceHandleV1(submitted.proposalHandle);
            return {
              ...submitted,
              proposal: flow.acceptProposal(submitted.proposal),
            };
          });
      }
    };

    return defineSequentialTool({
      name: metadata.name,
      label: metadata.label,
      description: metadata.description,
      parameters: metadata.parameters,
      execute: async (_toolCallId, params) => {
        const value = await execute(params);
        if (metadata.name === INVESTIGATION_TOOL_NAMES_V1.submitProposal) {
          return {
            ...toolResult(value),
            terminate: true,
          };
        }
        return toolResult(value);
      },
    });
  });

const providerFailureFromSession = (
  session: Awaited<ReturnType<typeof createAgentSession>>["session"],
  runtime: { readonly model: Model<Api> },
  outputObserved: boolean,
): PiProviderFailureError | undefined => {
  const latestAssistant = [...session.messages]
    .reverse()
    .find((message) => message.role === "assistant");
  if (
    latestAssistant?.role !== "assistant" ||
    (latestAssistant.stopReason !== "error" &&
      latestAssistant.stopReason !== "aborted")
  ) {
    return undefined;
  }
  return createPiProviderFailureError({
    message:
      latestAssistant.errorMessage ??
      session.agent.state.errorMessage ??
      "Pi provider request failed",
    phase: outputObserved ? "response_stream" : "request",
    provider: runtime.model.provider,
    model: runtime.model.id,
    stopReason: latestAssistant.stopReason === "aborted" ? "aborted" : "error",
  });
};

export const runV04PiDiagnosisWithRuntime = async (
  options: RuntimeOptions,
  runtime: { readonly modelRuntime: ModelRuntime; readonly model: Model<Api> },
): Promise<V04PiDiagnosisRunResult> => {
  parseResourceHandleV1(options.initialCapsuleHandle);
  const manifest = parseInvestigationCapabilityManifestV1(options.api.manifest);
  const flow = new V04ToolFlow(options.api);
  const customTools = createV04Tools(flow);
  const activeNames = customTools.map(
    (tool) => tool.name as InvestigationToolNameV1,
  );
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: options.sdkRetry ?? true, maxRetries: 2 },
  });
  const systemPrompt = buildV04SystemPrompt(options.additionalInstructions);
  const userPrompt = buildV04UserPrompt({
    initialCapsuleHandle: options.initialCapsuleHandle,
    manifest,
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
    systemPromptOverride: () => systemPrompt,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir: getAgentDir(),
    modelRuntime: runtime.modelRuntime,
    model: runtime.model,
    thinkingLevel: options.thinkingLevel ?? "medium",
    noTools: "all",
    tools: activeNames,
    excludeTools: [...BUILTIN_TOOL_NAMES],
    customTools: [...customTools],
    resourceLoader,
    sessionManager: SessionManager.create(
      options.cwd,
      join(options.runDir, "pi-sessions"),
    ),
    settingsManager,
  });

  const actualNames = session.getActiveToolNames().sort();
  const expectedNames = [...activeNames].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    session.dispose();
    throw new PiHarnessError(
      "AGENT_FAILED",
      `Pi activated unexpected tools: ${actualNames.join(", ")}`,
    );
  }
  const requestedThinking = options.thinkingLevel ?? "medium";
  if (session.thinkingLevel !== requestedThinking) {
    session.dispose();
    throw new PiHarnessError(
      "MODEL_CONFIGURATION",
      `Pi changed thinking level from ${requestedThinking} to ${session.thinkingLevel}`,
    );
  }

  const started = performance.now();
  let abortPromise: Promise<void> | undefined;
  let abortError: unknown;
  let outputObserved = false;
  let primaryError: unknown;
  const requestAbort = (): void => {
    if (abortPromise !== undefined) return;
    try {
      abortPromise = session.abort().catch((error: unknown) => {
        abortError ??= error;
      });
    } catch (error) {
      abortError ??= error;
    }
  };
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_end" && event.isError) {
      requestAbort();
    } else if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (
        ((update.type === "text_delta" ||
          update.type === "thinking_delta" ||
          update.type === "toolcall_delta") &&
          update.delta.length > 0) ||
        update.type === "toolcall_end" ||
        (update.type === "text_end" && update.content.length > 0) ||
        (update.type === "thinking_end" && update.content.length > 0)
      ) {
        outputObserved = true;
      }
    }
  });

  let result: V04PiDiagnosisRunResult | undefined;
  try {
    const timeoutMs = options.timeoutMs ?? 600_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      session.prompt(userPrompt, { expandPromptTemplates: false }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new PiHarnessError(
            "AGENT_TIMEOUT",
            `Pi v0.4 diagnosis timed out after ${timeoutMs}ms`,
          );
          requestAbort();
          reject(error);
        }, timeoutMs);
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });

    if (flow.terminalError !== undefined) throw flow.terminalError;
    const failedTool = session.messages.find(
      (message) => message.role === "toolResult" && message.isError,
    );
    if (failedTool?.role === "toolResult") {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        `V0.4 investigation tool ${failedTool.toolName} failed`,
      );
    }
    const providerFailure = providerFailureFromSession(
      session,
      runtime,
      outputObserved,
    );
    if (providerFailure !== undefined) throw providerFailure;
    const proposal = flow.getProposal();
    if (proposal === undefined) {
      throw new PiHarnessError(
        "PROPOSAL_MISSING",
        session.agent.state.errorMessage ??
          "Pi did not submit a v0.4 diagnosis proposal",
      );
    }
    if (!session.sessionFile) {
      throw new PiHarnessError("AGENT_FAILED", "Pi session was not persisted");
    }
    const thinkingLevel = normalizeThinking(session.thinkingLevel);
    const stats = session.getSessionStats();
    result = {
      proposal,
      toolCalls: flow.getCalls(),
      wallTimeMs: Math.max(0, Math.round(performance.now() - started)),
      piSession: {
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
        provider: runtime.model.provider,
        model: runtime.model.id,
        thinkingLevel,
        activeTools: [...activeNames],
        stats: {
          toolCalls: stats.toolCalls,
          tokens: {
            input: stats.tokens.input,
            output: stats.tokens.output,
            cacheRead: stats.tokens.cacheRead,
            cacheWrite: stats.tokens.cacheWrite,
            total: stats.tokens.total,
          },
          cost: stats.cost,
        },
        modelMetadata: {
          name: runtime.model.name,
          contextWindow: runtime.model.contextWindow,
          maxTokens: runtime.model.maxTokens,
          mappedThinkingValue:
            runtime.model.thinkingLevelMap?.[thinkingLevel] ?? null,
        },
        promptHashes: {
          system: digestText(systemPrompt),
          user: digestText(userPrompt),
        },
      },
    };
  } catch (error) {
    primaryError = flow.terminalError ?? error;
    throw primaryError;
  } finally {
    unsubscribe();
    if (!session.isIdle) requestAbort();
    if (abortPromise !== undefined) await abortPromise;
    let disposeError: unknown;
    try {
      session.dispose();
    } catch (error) {
      disposeError = error;
    }
    if (primaryError === undefined) {
      if (abortError !== undefined) {
        throw new PiHarnessError("AGENT_FAILED", "Pi session cleanup failed", {
          cause: abortError,
        });
      }
      if (disposeError !== undefined) {
        throw new PiHarnessError("AGENT_FAILED", "Pi session disposal failed", {
          cause: disposeError,
        });
      }
    }
  }

  if (result === undefined) {
    throw new PiHarnessError("AGENT_FAILED", "Pi v0.4 result was not built");
  }
  return result;
};

const latestToolResult = (context: Context, toolName: string): unknown => {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message?.role !== "toolResult" || message.toolName !== toolName) {
      continue;
    }
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    return JSON.parse(text) as unknown;
  }
  throw new PiHarnessError(
    "AGENT_FAILED",
    `Script could not observe result for ${toolName}`,
  );
};

const resolveScriptValue = <T>(
  value: V04ScriptValue<T>,
  observations: readonly V04ScriptObservation[],
): T =>
  typeof value === "function"
    ? (value as (items: readonly V04ScriptObservation[]) => T)(
        structuredClone(observations),
      )
    : value;

const scriptArguments = (
  name: InvestigationToolNameV1,
  value: unknown,
): UnknownRecord => {
  const metadata = toolMetadata(name);
  if (!Check(metadata.parameters, value)) {
    throw new PiHarnessError(
      "INVALID_ARGUMENT",
      `Script supplied invalid input for ${name}`,
    );
  }
  return value as UnknownRecord;
};

interface ScriptedResponses {
  readonly responses: readonly FauxResponseStep[];
  readonly error: () => PiHarnessError | undefined;
}

const scriptedResponses = (
  options: ScriptedV04PiHarnessOptions,
): ScriptedResponses => {
  const enabledNames = new Set(
    enabledToolDefinitions(options.api).map((definition) => definition.name),
  );
  const observations: V04ScriptObservation[] = [];
  const resolvedInputs: unknown[] = [];
  let scriptError: PiHarnessError | undefined;
  const guardScript = <T>(operation: () => T): T => {
    try {
      return operation();
    } catch (cause) {
      scriptError ??=
        cause instanceof PiHarnessError
          ? cause
          : new PiHarnessError(
              "INVALID_ARGUMENT",
              "Caller-authored v0.4 faux-model script failed",
              { cause },
            );
      throw scriptError;
    }
  };
  const capturePrevious = (context: Context, count: number): void => {
    if (count === 0 || observations.length >= count) return;
    const previous = options.steps[count - 1];
    if (previous === undefined) {
      throw new PiHarnessError("AGENT_FAILED", "Script step is missing");
    }
    observations.push({
      sequence: count,
      toolName: previous.toolName,
      input: structuredClone(resolvedInputs[count - 1]),
      result: structuredClone(latestToolResult(context, previous.toolName)),
    });
  };

  const responses: FauxResponseStep[] = options.steps.map((step, index) => {
    if (
      (step.toolName as InvestigationToolNameV1) ===
      INVESTIGATION_TOOL_NAMES_V1.submitProposal
    ) {
      throw new PiHarnessError(
        "INVALID_ARGUMENT",
        "Scripted v0.4 steps cannot contain the terminal proposal tool",
      );
    }
    if (!enabledNames.has(step.toolName)) {
      throw new PiHarnessError(
        "INVALID_ARGUMENT",
        `Script requested disabled tool ${step.toolName}`,
      );
    }
    if (typeof step.input !== "function") {
      scriptArguments(step.toolName, step.input);
    }
    return (context) =>
      guardScript(() => {
        capturePrevious(context, index);
        const input = resolveScriptValue(step.input, observations);
        resolvedInputs[index] = structuredClone(input);
        return fauxAssistantMessage(
          fauxToolCall(step.toolName, scriptArguments(step.toolName, input), {
            id: `v04-faux-${String(index + 1).padStart(2, "0")}`,
          }),
          {
            stopReason: "toolUse",
            timestamp: 1_735_689_600_000 + index + 1,
          },
        );
      });
  });

  if (typeof options.finalDraft !== "function") {
    parseDiagnosisProposalDraftV1(options.finalDraft);
  }

  responses.push((context) =>
    guardScript(() => {
      capturePrevious(context, options.steps.length);
      const draft = parseDiagnosisProposalDraftV1(
        resolveScriptValue(options.finalDraft, observations),
      );
      return fauxAssistantMessage(
        fauxToolCall(
          INVESTIGATION_TOOL_NAMES_V1.submitProposal,
          scriptArguments(INVESTIGATION_TOOL_NAMES_V1.submitProposal, draft),
          {
            id: `v04-faux-${String(options.steps.length + 1).padStart(2, "0")}`,
          },
        ),
        {
          stopReason: "toolUse",
          timestamp: 1_735_689_600_000 + options.steps.length + 1,
        },
      );
    }),
  );
  return { responses, error: () => scriptError };
};

export const runScriptedV04PiDiagnosisWithSdk = async (
  options: ScriptedV04PiHarnessOptions,
): Promise<V04PiDiagnosisRunResult> => {
  const script = scriptedResponses(options);
  const faux = fauxProvider({
    api: "chronorift-faux-v0.4",
    provider: SCRIPTED_PROVIDER,
    models: [
      {
        id: SCRIPTED_MODEL,
        name: "ChronoRift caller-scripted v0.4 model",
        reasoning: false,
        input: ["text"],
        contextWindow: 65_536,
        maxTokens: 8_192,
      },
    ],
    tokenSize: { min: 4, max: 4 },
  });
  faux.setResponses([...script.responses]);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = modelRuntime.getModel(SCRIPTED_PROVIDER, SCRIPTED_MODEL);
  if (model === undefined) {
    throw new PiHarnessError("MODEL_NOT_FOUND", "Faux v0.4 model is missing");
  }
  let result: V04PiDiagnosisRunResult;
  try {
    result = await runV04PiDiagnosisWithRuntime(
      { ...options, thinkingLevel: "off" },
      { modelRuntime, model },
    );
  } catch (error) {
    if (error instanceof PiHarnessError) throw error;
    throw script.error() ?? error;
  }
  if (
    faux.state.callCount !== script.responses.length ||
    faux.getPendingResponseCount() !== 0
  ) {
    throw new PiHarnessError(
      "AGENT_FAILED",
      "Faux v0.4 script was not consumed exactly",
    );
  }
  return result;
};

export const runV04PiDiagnosisWithSdk = async (
  options: V04PiHarnessOptions,
): Promise<V04PiDiagnosisRunResult> => {
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  const model = modelRuntime.getModel(options.provider, options.model);
  if (model === undefined) {
    throw new PiProviderFailureError(
      `Pi model ${options.provider}/${options.model} is not registered`,
      {
        phase: "request",
        code: "model_not_found",
        httpStatus: null,
        retryClass: "permanent",
        provider: options.provider,
        model: options.model,
      },
    );
  }
  const available = await modelRuntime.getAvailable(options.provider);
  if (!available.some((candidate) => candidate.id === options.model)) {
    throw new PiProviderFailureError(
      `Pi model ${options.provider}/${options.model} is not authenticated`,
      {
        phase: "request",
        code: "auth",
        httpStatus: null,
        retryClass: "permanent",
        provider: options.provider,
        model: options.model,
      },
    );
  }
  return runV04PiDiagnosisWithRuntime(options, { modelRuntime, model });
};
