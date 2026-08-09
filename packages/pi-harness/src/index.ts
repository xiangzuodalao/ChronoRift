export {
  PiHarnessError,
  PiProviderFailureError,
  type PiHarnessErrorCode,
  type PiProviderFailureCode,
  type PiProviderFailureOptions,
  type PiProviderFailurePhase,
  type PiProviderRetryClass,
} from "./errors.js";
export {
  assertPiModelCapabilities,
  listAvailablePiModels,
  persistPiApiKey,
  runDeterministicPiDiagnosis,
  runPiDiagnosis,
  runV03PiDiagnosis,
  runDeterministicV03PiDiagnosis,
  runV04PiDiagnosis,
  runScriptedV04PiDiagnosis,
} from "./harness.js";
export {
  createRestrictedSourceAccess,
  createVirtualSourceAccess,
} from "./source-access.js";
export {
  auditV03BlindPrompt,
  buildV03BlindSystemPrompt,
  buildV03BlindUserPrompt,
  v03FailureBriefAccessReceipt,
  v03FailureBriefReceiptId,
  type V03BlindPromptAudit,
} from "./internal/v03-prompt.js";
export type {
  AgentGameApi,
  AgentInterventionResult,
  AgentReplayResult,
  AssertPiModelCapabilitiesOptions,
  AvailablePiModel,
  CompareExecutionsRequest,
  DeterministicPiHarnessOptions,
  JsonArray,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ListAvailablePiModelsOptions,
  PersistPiApiKeyOptions,
  PersistPiApiKeyResult,
  PiDiagnosisRunResult,
  PiHarnessOptions,
  PiSessionReference,
  PiUsageStats,
  PiThinkingLevel,
  ReplayExecutionRequest,
  RestrictedSourceAccess,
  RestrictedSourceAccessOptions,
  RunInterventionRequest,
  SourceReadRequest,
  SourceReadResult,
  SourceSearchMatch,
  SourceSearchRequest,
  SourceSearchResult,
  VirtualSourceAccessOptions,
  VirtualSourceFile,
} from "./types.js";
export { V03_AGENT_BUDGETS } from "./v03-types.js";
export type * from "./v03-types.js";
export type * from "./v04-types.js";
export {
  createVNextCodingToolDefinitions,
  type BrokerToolDetails,
  type BrokerToolResult,
  type VNextCodingToolPort,
} from "./vnext-coding-tools.js";
export {
  createVNextGameToolDefinitions,
  VNextGameToolErrorEnvelopeV1Schema,
  VNextGameToolErrorV1Schema,
  VNextGameToolResponseV1Schema,
  VNextGameToolSuccessEnvelopeV1Schema,
  VNEXT_GAME_TOOL_ERROR_CODES_V1,
  type VNextGameToolErrorCodeV1,
  type VNextGameToolErrorEnvelopeV1,
  type VNextGameToolErrorV1,
  type VNextGameToolPort,
  type VNextGameToolPortRequestV1,
  type VNextGameToolResponseV1,
  type VNextGameToolSuccessEnvelopeV1,
} from "./vnext-game-tools.js";
export {
  configureVNextPiHostHttpTransport,
  createVNextPiHostHttpTransportConfigurer,
  hasVNextPiHostHttpProxy,
  type VNextPiHostHttpTransportDependencies,
} from "./vnext-host-http.js";
export {
  runVNextPiTurn,
  runVNextPiTurnWithSdk,
  VNEXT_ENVIRONMENT_APPENDIX,
  VNEXT_PI_WORKSPACE_CWD,
  type RunVNextPiTurnOptions,
  type RunVNextPiSdkTurnOptions,
  type VNextPiTurnResult,
} from "./vnext-session.js";
