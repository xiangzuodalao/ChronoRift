import { createHash } from "node:crypto";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

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
import {
  BenchmarkArmV1Schema,
  DiagnosisProposalV3Schema,
  EvidenceAccessReceiptV1Schema,
  EvidenceCapsuleV2Schema,
  ExperimentCandidateV1Schema,
  FailureBriefV1Schema,
  V03ExecutionComparisonSchema,
  V03ExecutionLogSchema,
  asCapsuleId,
  asEvidenceAccessReceiptId,
  asExecutionId,
  asInterventionId,
  type BenchmarkArmV1,
  type DiagnosisProposalV3,
  type EvidenceAccessKindV1,
  type EvidenceAccessReceiptId,
  type EvidenceAccessReceiptV1,
  type EvidenceCapsuleV2,
  type ExperimentCandidateV1,
  type FailureBriefV1,
  type JsonValue,
  type MechanismCodeV2,
  type SourceCoverageV1,
  type V03ExecutionComparison,
  type V03ExecutionLog,
} from "@chronorift/domain";
import { Type, type TSchema } from "typebox";

import { PiHarnessError, PiProviderFailureError } from "../errors.js";
import type {
  DeterministicV03PiHarnessOptions,
  V03ExperimentResult,
  V03PiDiagnosisRunResult,
  V03PiHarnessOptions,
  V03PiPartialObservationV3,
  V03PiProgressSnapshotV3,
  V03ReplayResult,
} from "../v03-types.js";
import { createPiProviderFailureError } from "./provider-failure.js";
import { V03SessionGuard } from "./v03-session-guard.js";
import {
  buildV03BlindSystemPrompt,
  buildV03BlindUserPrompt,
  v03FailureBriefReceiptId,
} from "./v03-prompt.js";
import {
  assertV03ProgressMonotonic,
  legacyV03ProgressSnapshot,
} from "./v03-progress.js";

const DETERMINISTIC_PROVIDER = "chronorift-faux";
const DETERMINISTIC_MODEL = "chronorift-v0.3";
const BUILTIN_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;
const strictObject = { additionalProperties: false } as const;
const IdSchema = Type.String({ minLength: 1 });

const defineSequentialTool = <
  TParams extends TSchema,
  TDetails = unknown,
  TState = unknown,
>(
  tool: ToolDefinition<TParams, TDetails, TState>,
) => defineTool({ ...tool, executionMode: "sequential" });

type UnknownRecord = Record<string, unknown>;

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as UnknownRecord;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
};

const digestValue = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

const asRecord = (value: unknown, label: string): UnknownRecord => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as UnknownRecord;
};

const asString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is not a non-empty string`);
  }
  return value;
};

const toolValue = (context: Context, name: string): unknown => {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message?.role !== "toolResult" || message.toolName !== name) continue;
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const value = JSON.parse(text) as unknown;
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, "data") &&
      Object.prototype.hasOwnProperty.call(value, "accessReceipt")
    ) {
      return (value as UnknownRecord)["data"];
    }
    return value;
  }
  throw new Error(`Missing ${name} result`);
};

const receiptIds = (context: Context): string[] => {
  const ids: string[] = [];
  for (const message of context.messages) {
    if (message.role !== "toolResult") continue;
    const value = JSON.parse(
      message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    ) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const receipt = (value as UnknownRecord)["accessReceipt"];
    if (
      receipt === null ||
      typeof receipt !== "object" ||
      Array.isArray(receipt)
    ) {
      continue;
    }
    const id = (receipt as UnknownRecord)["receiptId"];
    if (typeof id === "string") ids.push(id);
  }
  return [...new Set(ids)];
};

const symbolsFromLine = (line: string): readonly string[] => {
  const match = /^\s*(?:func|function)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/u.exec(
    line,
  );
  return match?.[1] === undefined ? [] : [match[1]];
};

const readCoverage = (value: unknown): readonly SourceCoverageV1[] => {
  const result = asRecord(value, "source read result");
  const path = asString(result["path"], "source path");
  const startLine = Number(result["startLine"]);
  const endLine = Number(result["endLine"]);
  const content = asString(result["content"], "source content");
  const coveredSymbols = content
    .split("\n")
    .flatMap((line) => symbolsFromLine(line));
  return [{ virtualPath: path, startLine, endLine, coveredSymbols }];
};

const searchCoverage = (value: unknown): readonly SourceCoverageV1[] => {
  const result = asRecord(value, "source search result");
  const matches = Array.isArray(result["matches"]) ? result["matches"] : [];
  const coverage = matches.flatMap((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const match = entry as UnknownRecord;
    const path = match["path"];
    const line = match["line"];
    const text = match["text"];
    if (
      typeof path !== "string" ||
      typeof line !== "number" ||
      typeof text !== "string"
    ) {
      return [];
    }
    return [
      {
        virtualPath: path,
        startLine: line,
        endLine: line,
        coveredSymbols: symbolsFromLine(text),
      },
    ];
  });
  return coverage;
};

const toolJson = (context: Context, name: string): UnknownRecord =>
  asRecord(toolValue(context, name), `${name} result`);

const eventRecords = (execution: UnknownRecord): UnknownRecord[] =>
  Array.isArray(execution["events"])
    ? execution["events"].flatMap((event) =>
        event !== null && typeof event === "object" && !Array.isArray(event)
          ? [event as UnknownRecord]
          : [],
      )
    : [];

const mechanismFromExecution = (execution: UnknownRecord): MechanismCodeV2 => {
  const events = eventRecords(execution);
  if (
    events.some(
      (event) =>
        event["kind"] === "signal_delivery" &&
        event["failureReason"] === "receiver_not_connected",
    ) &&
    events.some(
      (event) =>
        event["kind"] === "property_changed" &&
        typeof event["path"] === "string" &&
        event["path"].endsWith("receiver_connected"),
    )
  ) {
    return "signal_before_receiver_connection";
  }
  if (events.some((event) => event["kind"] === "spatial_sample")) {
    return "discrete_physics_tunneling";
  }
  if (events.some((event) => event["kind"] === "entity_lifecycle")) {
    return "stale_effect_crossed_entity_incarnation";
  }
  if (
    events.some(
      (event) =>
        event["kind"] === "property_changed" &&
        event["path"] === "player.window_open",
    )
  ) {
    return "frame_count_used_for_time_window";
  }
  return "unknown";
};

const candidateForMechanism = (
  candidates: readonly UnknownRecord[],
  mechanism: MechanismCodeV2,
): UnknownRecord => {
  const selected = candidates.find((candidate) => {
    const intervention = asRecord(
      candidate["intervention"],
      "candidate.intervention",
    );
    if (mechanism === "signal_before_receiver_connection") {
      return intervention["kind"] === "shift_input";
    }
    if (mechanism === "frame_count_used_for_time_window") {
      return (
        intervention["kind"] === "set_runtime_control" &&
        intervention["name"] === "fixed_fps" &&
        intervention["value"] === 60
      );
    }
    if (mechanism === "discrete_physics_tunneling") {
      return (
        intervention["kind"] === "set_runtime_control" &&
        intervention["name"] === "physics_ticks_per_second"
      );
    }
    if (mechanism === "stale_effect_crossed_entity_incarnation") {
      return (
        intervention["kind"] === "set_fixture_control" &&
        intervention["name"] === "pooling_enabled" &&
        intervention["value"] === false
      );
    }
    return false;
  });
  if (selected === undefined)
    throw new Error("No grounded experiment candidate");
  return selected;
};

export class V03ToolFlow {
  private genericBaseline: V03ExecutionLog | undefined;
  private capsule: EvidenceCapsuleV2 | undefined;
  private readonly replays: V03ReplayResult[] = [];
  private experiments: readonly ExperimentCandidateV1[] | undefined;
  private readonly experimentResults: V03ExperimentResult[] = [];
  private readonly comparisons: V03ExecutionComparison[] = [];
  private proposal: DiagnosisProposalV3 | undefined;
  private sourceCalls = 0;
  private readonly receipts: EvidenceAccessReceiptV1[] = [];
  private readonly receiptIdsByHandle = new Map<
    string,
    EvidenceAccessReceiptId
  >();
  private readonly accessKeys = new Set<string>();
  private readonly failureBrief: FailureBriefV1;
  private semanticRevision = 0;
  private toolInFlight = false;
  private terminalToolViolation: PiHarnessError | undefined;

  public constructor(
    private readonly options: DeterministicV03PiHarnessOptions,
  ) {
    this.failureBrief = FailureBriefV1Schema.parse(options.failureBrief);
    if (
      this.failureBrief.capsuleId !== options.initialCapsuleId ||
      this.failureBrief.baselineExecutionId !== options.baselineExecutionId
    ) {
      throw new PiHarnessError(
        "INVALID_ARGUMENT",
        "Failure Brief IDs do not match the scoped investigation",
      );
    }
    this.recordAccess(
      "failure_brief",
      this.failureBrief.capsuleId,
      { delivery: "initial_prompt" },
      this.failureBrief,
      [],
      false,
    );
  }

  public get progressObserved(): boolean {
    return this.semanticRevision > 0;
  }

  public getSemanticRevision(): number {
    return this.semanticRevision;
  }

  public hasSubmittedProposal(): boolean {
    return this.proposal !== undefined;
  }

  public get failureBriefReceiptId(): string {
    return v03FailureBriefReceiptId(this.failureBrief);
  }

  public async runTool<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.terminalToolViolation !== undefined) {
      throw this.terminalToolViolation;
    }
    if (this.toolInFlight) {
      const violation = new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Concurrent diagnostic tool calls are not allowed",
      );
      this.terminalToolViolation = violation;
      throw violation;
    }
    this.toolInFlight = true;
    try {
      return await operation();
    } catch (error) {
      this.terminalToolViolation ??=
        error instanceof PiHarnessError
          ? error
          : new PiHarnessError(
              "AGENT_FAILED",
              "Diagnostic tool execution failed",
              { cause: error },
            );
      throw error;
    } finally {
      this.toolInFlight = false;
    }
  }

  public getTerminalToolViolation(): PiHarnessError | undefined {
    return this.terminalToolViolation;
  }

  private recordAccess(
    accessKind: EvidenceAccessKindV1,
    resourceId: string,
    request: unknown,
    content: unknown,
    sourceCoverage: readonly SourceCoverageV1[],
    semanticProgress = true,
  ): EvidenceAccessReceiptV1 {
    const requestHash = digestValue(request);
    const key = `${accessKind}\0${requestHash}`;
    if (this.accessKeys.has(key)) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        `Repeated ${accessKind} access is not allowed`,
      );
    }
    const contentHash = digestValue(content);
    const receiptId = asEvidenceAccessReceiptId(
      `receipt:v1:${digestValue({
        runId: this.failureBrief.runId,
        fixtureId: this.failureBrief.fixtureId,
        accessKind,
        resourceId,
        requestHash,
        contentHash,
        sourceCoverage,
      })}`,
    );
    if (
      accessKind === "failure_brief" &&
      receiptId !== v03FailureBriefReceiptId(this.failureBrief)
    ) {
      throw new PiHarnessError(
        "INVALID_GAME_RESULT",
        "Failure Brief receipt identity is inconsistent",
      );
    }
    const receipt = EvidenceAccessReceiptV1Schema.parse({
      schemaVersion: 1,
      receiptId,
      runId: this.failureBrief.runId,
      fixtureId: this.failureBrief.fixtureId,
      accessKind,
      resourceId,
      requestHash,
      contentHash,
      sourceCoverage,
      issuedAt: this.options.receiptIssuedAt ?? new Date().toISOString(),
    });
    this.accessKeys.add(key);
    this.receipts.push(receipt);
    this.receiptIdsByHandle.set(`@r${this.receipts.length - 1}`, receiptId);
    if (semanticProgress) this.semanticRevision += 1;
    return structuredClone(receipt);
  }

  private receiptHandle(receiptId: EvidenceAccessReceiptId): string {
    for (const [handle, candidate] of this.receiptIdsByHandle) {
      if (candidate === receiptId) return handle;
    }
    throw new PiHarnessError(
      "AGENT_FAILED",
      "Evidence receipt handle table is inconsistent",
    );
  }

  private accessed<T>(
    accessKind: EvidenceAccessKindV1,
    resourceId: string,
    request: unknown,
    data: T,
    sourceCoverage: readonly SourceCoverageV1[] = [],
    semanticProgress = true,
  ): {
    readonly data: T;
    readonly accessReceipt: EvidenceAccessReceiptV1;
    readonly accessHandle: string;
  } {
    const accessReceipt = this.recordAccess(
      accessKind,
      resourceId,
      request,
      data,
      sourceCoverage,
      semanticProgress,
    );
    return {
      data,
      accessReceipt,
      accessHandle: this.receiptHandle(accessReceipt.receiptId),
    };
  }

  private assertOpen(): void {
    if (this.proposal !== undefined) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Diagnosis proposal was already submitted",
      );
    }
  }

  public async rawBaseline(executionId: string): Promise<unknown> {
    this.assertOpen();
    if (this.options.arm !== "generic") {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Raw baseline is generic-only",
      );
    }
    if (executionId !== this.options.baselineExecutionId) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Baseline execution ID is out of scope",
      );
    }
    const raw = await this.options.game.getRawBaseline(
      asExecutionId(executionId),
    );
    const execution = asRecord(
      asRecord(raw, "raw baseline")["execution"],
      "raw execution",
    );
    this.genericBaseline = V03ExecutionLogSchema.parse(execution);
    return this.accessed("raw_execution", executionId, { executionId }, raw);
  }

  public async rawReplay(executionId: string): Promise<unknown> {
    this.assertOpen();
    if (this.options.arm !== "generic") {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Raw replay is generic-only",
      );
    }
    if (this.genericBaseline === undefined) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Read the raw baseline before replay",
      );
    }
    if (this.replays.length >= 1) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Raw replay budget exhausted",
      );
    }
    if (executionId !== this.options.baselineExecutionId) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Replay target is out of scope",
      );
    }
    const replay = await this.options.game.replayExecution(
      asExecutionId(executionId),
    );
    const parsed = {
      ...replay,
      execution: V03ExecutionLogSchema.parse(replay.execution),
    };
    if (
      parsed.execution.executionId === executionId ||
      parsed.sourceDigest !== this.genericBaseline.timelineDigest ||
      parsed.replayDigest !== parsed.execution.timelineDigest ||
      parsed.matches !== (parsed.sourceDigest === parsed.replayDigest)
    ) {
      throw new PiHarnessError(
        "INVALID_GAME_RESULT",
        "Invalid raw replay receipt",
      );
    }
    this.replays.push(structuredClone(parsed));
    return this.accessed(
      "replay",
      parsed.execution.executionId,
      { executionId },
      {
        execution: parsed.execution,
        matches: parsed.matches,
        sourceDigest: parsed.sourceDigest,
        replayDigest: parsed.replayDigest,
      },
    );
  }

  public async capsuleById(capsuleId: string): Promise<EvidenceCapsuleV2> {
    this.assertOpen();
    if (this.options.arm === "generic") {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Generic arm has no Capsule tool",
      );
    }
    if (capsuleId !== this.options.initialCapsuleId) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Capsule ID is out of scope",
      );
    }
    if (this.capsule !== undefined) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Evidence Capsule was already read",
      );
    }
    const raw = await this.options.game.getEvidenceCapsule(
      asCapsuleId(capsuleId),
    );
    if (raw === null)
      throw new PiHarnessError("INVALID_ARGUMENT", "Unknown Capsule");
    this.capsule = EvidenceCapsuleV2Schema.parse(raw);
    return this.accessed(
      "capsule",
      capsuleId,
      { capsuleId },
      structuredClone(this.capsule),
    ) as unknown as EvidenceCapsuleV2;
  }

  public async replay(executionId: string): Promise<V03ReplayResult> {
    this.assertOpen();
    if (this.options.arm === "generic") {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Generic arm has no strict replay tool",
      );
    }
    if (this.replays.length >= 1) {
      throw new PiHarnessError("INVALID_TOOL_FLOW", "Replay budget exhausted");
    }
    if (this.capsule === undefined) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Read the Capsule before replay",
      );
    }
    if (executionId !== this.options.baselineExecutionId) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Replay target is out of scope",
      );
    }
    const replay = await this.options.game.replayExecution(
      asExecutionId(executionId),
    );
    const parsed = {
      ...replay,
      execution: V03ExecutionLogSchema.parse(replay.execution),
    };
    if (
      parsed.execution.executionId === executionId ||
      parsed.sourceDigest !== this.capsule.timelineDigest ||
      parsed.replayDigest !== parsed.execution.timelineDigest ||
      parsed.matches !== (parsed.sourceDigest === parsed.replayDigest)
    ) {
      throw new PiHarnessError(
        "INVALID_GAME_RESULT",
        "Invalid strict replay receipt",
      );
    }
    this.replays.push(structuredClone(parsed));
    return this.accessed(
      "replay",
      parsed.execution.executionId,
      { executionId },
      structuredClone(parsed),
    ) as unknown as V03ReplayResult;
  }

  public async listExperiments(): Promise<readonly ExperimentCandidateV1[]> {
    this.assertOpen();
    if (this.options.arm === "evidence-only") {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Ablation arm has no experiment catalog",
      );
    }
    if (
      (this.options.arm === "chronorift-full" ||
        this.options.arm === "generic") &&
      this.replays.length !== 1
    ) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Strict replay is required before experiments",
      );
    }
    if (this.experiments !== undefined) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Experiment catalog was already read",
      );
    }
    this.experiments = (await this.options.game.listExperiments()).map(
      (candidate) => ExperimentCandidateV1Schema.parse(candidate),
    );
    return this.accessed(
      "experiment",
      "experiment-catalog",
      {},
      structuredClone(this.experiments),
      [],
      this.experiments.length > 0,
    ) as unknown as readonly ExperimentCandidateV1[];
  }

  public async runExperiment(
    baselineExecutionId: string,
    interventionId: string,
  ): Promise<unknown> {
    this.assertOpen();
    if (this.options.arm === "evidence-only") {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Ablation arm cannot intervene",
      );
    }
    if (this.experiments === undefined) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "List experiments before running one",
      );
    }
    if (this.experimentResults.length >= 2) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Experiment budget exhausted",
      );
    }
    if (baselineExecutionId !== this.options.baselineExecutionId) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Experiment baseline is out of scope",
      );
    }
    if (
      !this.experiments.some((entry) => entry.interventionId === interventionId)
    ) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Intervention is not in the catalog",
      );
    }
    const result = await this.options.game.runExperiment(
      asExecutionId(baselineExecutionId),
      asInterventionId(interventionId),
    );
    const parsed: V03ExperimentResult = {
      interventionId: asInterventionId(interventionId),
      execution: V03ExecutionLogSchema.parse(result.execution),
    };
    this.experimentResults.push(structuredClone(parsed));
    const data =
      this.options.arm === "generic"
        ? {
            interventionId: parsed.interventionId,
            executionId: parsed.execution.executionId,
            rawEvents: parsed.execution.events,
            finalState: parsed.execution.finalState,
            contractOutcome: parsed.execution.evaluation.status,
          }
        : structuredClone(parsed);
    return this.accessed(
      "experiment",
      parsed.execution.executionId,
      { baselineExecutionId, interventionId },
      data,
    );
  }

  public async compare(
    baselineExecutionId: string,
    candidateExecutionId: string,
  ): Promise<V03ExecutionComparison> {
    this.assertOpen();
    if (this.options.arm !== "chronorift-full") {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Structured comparison is full-arm only",
      );
    }
    if (baselineExecutionId !== this.options.baselineExecutionId) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Comparison baseline is out of scope",
      );
    }
    if (
      !this.experimentResults.some(
        (result) => result.execution.executionId === candidateExecutionId,
      )
    ) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Candidate was not returned by this session",
      );
    }
    const comparison = V03ExecutionComparisonSchema.parse(
      await this.options.game.compareExecutions(
        asExecutionId(baselineExecutionId),
        asExecutionId(candidateExecutionId),
      ),
    );
    this.comparisons.push(structuredClone(comparison));
    return this.accessed(
      "comparison",
      comparison.comparisonId,
      { baselineExecutionId, candidateExecutionId },
      structuredClone(comparison),
    ) as unknown as V03ExecutionComparison;
  }

  public async sourceRead(request: {
    readonly path: string;
    readonly offset?: number | undefined;
    readonly limit?: number | undefined;
  }): Promise<unknown> {
    this.assertSourceBudget();
    const sourceRequest = {
      path: request.path,
      ...(request.offset === undefined ? {} : { offset: request.offset }),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
    };
    const data = await this.options.source.read(sourceRequest);
    const coverage = readCoverage(data);
    return this.accessed(
      "source_read",
      data.path,
      sourceRequest,
      data,
      coverage,
      data.content.trim().length > 0 && coverage.length > 0,
    );
  }

  public async sourceSearch(request: {
    readonly query: string;
    readonly path?: string | undefined;
    readonly includeSuffixes?: readonly string[] | undefined;
    readonly maxResults?: number | undefined;
  }): Promise<unknown> {
    this.assertSourceBudget();
    const sourceRequest = {
      query: request.query,
      ...(request.path === undefined ? {} : { path: request.path }),
      ...(request.includeSuffixes === undefined
        ? {}
        : { includeSuffixes: request.includeSuffixes }),
      ...(request.maxResults === undefined
        ? {}
        : { maxResults: request.maxResults }),
    };
    const data = await this.options.source.search(sourceRequest);
    const coverage = searchCoverage(data);
    return this.accessed(
      "source_search",
      request.path ?? ".",
      sourceRequest,
      data,
      coverage,
      data.matches.length > 0 && coverage.length > 0,
    );
  }

  private assertSourceBudget(): void {
    this.assertOpen();
    this.sourceCalls += 1;
    if (this.sourceCalls > 4) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Source tool budget exhausted",
      );
    }
  }

  public submit(raw: unknown): DiagnosisProposalV3 {
    this.assertOpen();
    const normalized =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? {
            ...raw,
            accessReceiptIds: Array.isArray(
              (raw as Record<string, unknown>)["accessReceiptIds"],
            )
              ? (
                  (raw as Record<string, unknown>)[
                    "accessReceiptIds"
                  ] as unknown[]
                ).map((reference) =>
                  typeof reference === "string"
                    ? (this.receiptIdsByHandle.get(reference) ?? reference)
                    : reference,
                )
              : (raw as Record<string, unknown>)["accessReceiptIds"],
          }
        : raw;
    const parsed = DiagnosisProposalV3Schema.safeParse(normalized);
    if (!parsed.success) {
      throw new PiHarnessError(
        "INVALID_DIAGNOSIS",
        "Diagnosis proposal failed strict validation",
        { cause: parsed.error },
      );
    }
    const proposal = parsed.data;
    if (
      proposal.runId !== this.failureBrief.runId ||
      proposal.fixtureId !== this.failureBrief.fixtureId
    ) {
      throw new PiHarnessError(
        "INVALID_DIAGNOSIS",
        "Proposal scope does not match the Failure Brief",
      );
    }
    if (
      proposal.capsuleId !== this.options.initialCapsuleId ||
      proposal.baselineExecutionId !== this.options.baselineExecutionId
    ) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Proposal IDs are out of scope",
      );
    }
    const comparisonIds = new Set(
      this.comparisons.map((comparison) => comparison.comparisonId),
    );
    if (
      proposal.comparisonIds.some((id) => !comparisonIds.has(id)) ||
      (this.options.arm !== "chronorift-full" &&
        proposal.comparisonIds.length > 0)
    ) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Proposal comparison IDs are ungrounded",
      );
    }
    const candidateIds = new Set(
      this.experimentResults.map((result) => result.execution.executionId),
    );
    if (
      proposal.candidateExecutionIds.some((id) => !candidateIds.has(id)) ||
      (this.options.arm === "evidence-only" &&
        proposal.candidateExecutionIds.length > 0)
    ) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Proposal candidate execution IDs are ungrounded",
      );
    }
    const accessReceiptIds = new Set(
      this.receipts.map((receipt) => receipt.receiptId),
    );
    if (proposal.accessReceiptIds.some((id) => !accessReceiptIds.has(id))) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Proposal access receipt IDs are ungrounded",
      );
    }
    if (
      proposal.replayExecutionId !== undefined &&
      !this.replays.some(
        (replay) => replay.execution.executionId === proposal.replayExecutionId,
      )
    ) {
      throw new PiHarnessError(
        "INVALID_TOOL_FLOW",
        "Proposal replay ID is ungrounded",
      );
    }
    const availableEventIds = new Set([
      this.failureBrief.triggerEventId,
      ...(this.genericBaseline?.events.map((event) => event.eventId) ?? []),
      ...(this.capsule?.eventChain.map((event) => event.eventId) ?? []),
      ...this.replays.flatMap((replay) =>
        replay.execution.events.map((event) => event.eventId),
      ),
      ...this.experimentResults.flatMap((result) =>
        result.execution.events.map((event) => event.eventId),
      ),
    ]);
    if (
      proposal.evidenceEventIds.some(
        (eventId) => !availableEventIds.has(eventId),
      )
    ) {
      throw new PiHarnessError(
        "INVALID_DIAGNOSIS",
        "Proposal evidence event IDs are ungrounded",
      );
    }
    this.proposal = structuredClone(proposal);
    this.semanticRevision += 1;
    return structuredClone(proposal);
  }

  public getProposal(): DiagnosisProposalV3 | undefined {
    return this.proposal === undefined
      ? undefined
      : structuredClone(this.proposal);
  }

  public getReceipts(): readonly EvidenceAccessReceiptV1[] {
    return structuredClone(this.receipts);
  }

  public getPartialFlow(): V03PiPartialObservationV3["flow"] {
    return {
      matchingReplay:
        this.replays.length > 0 &&
        this.replays.every((replay) => replay.matches),
      interventionCount: this.experimentResults.length,
      comparisonCount: this.comparisons.length,
    };
  }
}

const jsonContent = (value: unknown) => [
  { type: "text" as const, text: JSON.stringify(value, null, 2) },
];

const toolResult = (value: unknown) => ({
  content: jsonContent(value),
  details: value,
});

const ProposalToolSchema = Type.Object(
  {
    schemaVersion: Type.Literal(3),
    proposalId: IdSchema,
    runId: IdSchema,
    fixtureId: IdSchema,
    capsuleId: IdSchema,
    baselineExecutionId: IdSchema,
    replayExecutionId: Type.Optional(IdSchema),
    candidateExecutionIds: Type.Array(IdSchema),
    comparisonIds: Type.Array(IdSchema),
    accessReceiptIds: Type.Array(IdSchema),
    mechanismCode: Type.Union([
      Type.Literal("signal_before_receiver_connection"),
      Type.Literal("frame_count_used_for_time_window"),
      Type.Literal("discrete_physics_tunneling"),
      Type.Literal("stale_effect_crossed_entity_incarnation"),
      Type.Literal("unknown"),
    ]),
    summary: Type.String({ minLength: 1 }),
    evidenceEventIds: Type.Array(IdSchema),
    suspectedSource: Type.Optional(
      Type.Object(
        {
          path: Type.String({ minLength: 1 }),
          symbol: Type.Optional(Type.String({ minLength: 1 })),
        },
        strictObject,
      ),
    ),
    blockers: Type.Array(Type.String({ minLength: 1 })),
    nextExperiment: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
  },
  strictObject,
);

export const createV03Tools = (
  flow: V03ToolFlow,
  arm: BenchmarkArmV1,
): readonly ToolDefinition[] => {
  const tools: ToolDefinition[] = [];
  if (arm === "generic") {
    tools.push(
      defineSequentialTool({
        name: "game_get_raw_baseline",
        label: "Get raw baseline",
        description:
          "Read the initial raw runtime event transcript and final state.",
        parameters: Type.Object({ executionId: IdSchema }, strictObject),
        execute: async (_id, params) =>
          toolResult(
            await flow.runTool(() => flow.rawBaseline(params.executionId)),
          ),
      }),
      defineSequentialTool({
        name: "game_replay_raw_baseline",
        label: "Replay raw baseline",
        description:
          "Rerun the baseline and return its raw runtime transcript. Complete this before any experiment tool.",
        parameters: Type.Object({ executionId: IdSchema }, strictObject),
        execute: async (_id, params) =>
          toolResult(
            await flow.runTool(() => flow.rawReplay(params.executionId)),
          ),
      }),
    );
  } else {
    tools.push(
      defineSequentialTool({
        name: "game_get_evidence_capsule_v2",
        label: "Get Evidence Capsule v2",
        description: "Read the immutable causal evidence Capsule.",
        parameters: Type.Object({ capsuleId: IdSchema }, strictObject),
        execute: async (_id, params) =>
          toolResult(
            await flow.runTool(() => flow.capsuleById(params.capsuleId)),
          ),
      }),
      defineSequentialTool({
        name: "game_replay_execution_v2",
        label: "Strict replay",
        description:
          "Restore the frozen checkpoint and replay the baseline. Complete this before any experiment tool.",
        parameters: Type.Object({ executionId: IdSchema }, strictObject),
        execute: async (_id, params) =>
          toolResult(await flow.runTool(() => flow.replay(params.executionId))),
      }),
    );
  }
  if (arm !== "evidence-only") {
    tools.push(
      defineSequentialTool({
        name: "game_list_experiments_v2",
        label: "List experiments",
        description:
          "List the two allowlisted single-variable experiments. Prerequisite: the active baseline replay succeeded.",
        parameters: Type.Object({}, strictObject),
        execute: async () =>
          toolResult(await flow.runTool(() => flow.listExperiments())),
      }),
      defineSequentialTool({
        name: "game_run_experiment_v2",
        label: "Run experiment",
        description:
          "Run one interventionId returned by the experiment list after replay. baselineExecutionId must be the frozen FailureBrief baseline, never the replay result; at most two are permitted.",
        parameters: Type.Object(
          { baselineExecutionId: IdSchema, interventionId: IdSchema },
          strictObject,
        ),
        execute: async (_id, params) =>
          toolResult(
            await flow.runTool(() =>
              flow.runExperiment(
                params.baselineExecutionId,
                params.interventionId,
              ),
            ),
          ),
      }),
    );
  }
  if (arm === "chronorift-full") {
    tools.push(
      defineSequentialTool({
        name: "game_compare_executions_v2",
        label: "Compare executions",
        description:
          "Compare the frozen FailureBrief baselineExecutionId with a candidateExecutionId returned by an experiment; validates lineage, realized controls, outcomes, and divergence.",
        parameters: Type.Object(
          { baselineExecutionId: IdSchema, candidateExecutionId: IdSchema },
          strictObject,
        ),
        execute: async (_id, params) =>
          toolResult(
            await flow.runTool(() =>
              flow.compare(
                params.baselineExecutionId,
                params.candidateExecutionId,
              ),
            ),
          ),
      }),
    );
  }
  tools.push(
    defineSequentialTool({
      name: "source_read_v1",
      label: "Read Fixture source",
      description: "Read bounded text from the current Fixture source root.",
      parameters: Type.Object(
        {
          path: Type.String({ minLength: 1 }),
          offset: Type.Optional(Type.Integer({ minimum: 1 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
        },
        strictObject,
      ),
      execute: async (_id, params) =>
        toolResult(await flow.runTool(() => flow.sourceRead(params))),
    }),
    defineSequentialTool({
      name: "source_search_v1",
      label: "Search Fixture source",
      description: "Search bounded text in the current Fixture source root.",
      parameters: Type.Object(
        {
          query: Type.String({ minLength: 1 }),
          path: Type.Optional(Type.String({ minLength: 1 })),
          includeSuffixes: Type.Optional(
            Type.Array(Type.String({ minLength: 2 }), { minItems: 1 }),
          ),
          maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
        },
        strictObject,
      ),
      execute: async (_id, params) =>
        toolResult(await flow.runTool(() => flow.sourceSearch(params))),
    }),
    defineSequentialTool({
      name: "submit_diagnosis_proposal",
      label: "Submit diagnosis",
      description:
        "Final call after replay and evidence gathering. Populate every required field and array, including evidenceEventIds. For accessReceiptIds, use the short accessHandle values returned by tools; the Harness resolves them to exact content-addressed receipt IDs before validation. Only the Harness can emit a verdict.",
      parameters: ProposalToolSchema,
      execute: async (_id, params) => {
        const proposal = await flow.runTool(() => flow.submit(params));
        return {
          content: jsonContent({ accepted: true, proposal }),
          details: { accepted: true, proposal },
          terminate: true,
        };
      },
    }),
  );
  return tools;
};

const promptInput = (options: DeterministicV03PiHarnessOptions): JsonValue =>
  FailureBriefV1Schema.parse(options.failureBrief) as unknown as JsonValue;

const digestText = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const normalizeThinking = (value: string) => {
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
    `Unsupported thinking level ${value}`,
  );
};

const progressCounter = (
  value: number | undefined,
  fallback: number,
  label: string,
): number => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new PiHarnessError(
      "AGENT_FAILED",
      `Pi v0.3 progress counter ${label} is invalid`,
    );
  }
  return result;
};

export const runV03PiDiagnosisWithRuntime = async (
  options: DeterministicV03PiHarnessOptions,
  runtime: { readonly modelRuntime: ModelRuntime; readonly model: Model<Api> },
): Promise<V03PiDiagnosisRunResult> => {
  const arm = BenchmarkArmV1Schema.parse(options.arm);
  const flow = new V03ToolFlow(options);
  const customTools = createV03Tools(flow, arm);
  const activeNames = customTools.map((tool) => tool.name);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: options.sdkRetry ?? true, maxRetries: 2 },
  });
  const blindSystemPrompt = buildV03BlindSystemPrompt(
    options.additionalInstructions,
  );
  const blindUserPrompt = buildV03BlindUserPrompt(
    promptInput(options),
    flow.failureBriefReceiptId,
  );
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => blindSystemPrompt,
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
  const started = performance.now();
  let progressChain = Promise.resolve();
  let progressError: PiHarnessError | undefined;
  let progressSignature = "";
  let progressSequence = 0;
  let previousProgress: V03PiProgressSnapshotV3 | undefined;
  let modelRequestStarted = false;
  let modelOutputObserved = false;
  let currentResponseOutputObserved = false;
  let modelTurnCompleted = false;
  let abortPromise: Promise<void> | undefined;
  let abortError: unknown;
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
  const guard = new V03SessionGuard({
    semanticRevision: () => flow.getSemanticRevision(),
    terminalToolViolation: () => flow.getTerminalToolViolation(),
    requestAbort,
  });

  const enqueueProgress = (): void => {
    if (
      options.onProgress === undefined &&
      options.onProgressV3 === undefined &&
      options.onPartialObservationV3 === undefined
    ) {
      return;
    }
    try {
      const stats = session.getSessionStats();
      const baselineExecutions = progressCounter(
        options.game.baselineExecutions,
        1,
        "game.baselineExecutions",
      );
      const diagnosticExecutions = progressCounter(
        options.game.diagnosticExecutions,
        0,
        "game.diagnosticExecutions",
      );
      const sessionPersisted = session.sessionFile !== undefined;
      const accessReceipts = flow.getReceipts();
      const partialFlow = flow.getPartialFlow();
      const signature = canonicalJson({
        modelRequestStarted,
        modelOutputObserved,
        modelTurnCompleted,
        tokens: stats.tokens,
        toolsStarted: guard.toolCalls,
        toolsCompleted: guard.completedToolCalls,
        toolsFailed: guard.toolErrors,
        semanticRevision: flow.getSemanticRevision(),
        consecutiveNonProgress: guard.consecutiveNonProgressToolResults,
        baselineExecutions,
        diagnosticExecutions,
        proposalSubmitted: flow.hasSubmittedProposal(),
        sessionPersisted,
        accessReceiptIds: accessReceipts.map((receipt) => receipt.receiptId),
        partialFlow,
      });
      if (signature === progressSignature) return;
      const snapshot: V03PiProgressSnapshotV3 = {
        schemaVersion: 3,
        sequence: progressSequence + 1,
        wallTimeMs: Math.max(0, Math.round(performance.now() - started)),
        fixtureStage: "fixture_validated",
        model: {
          requestStarted: modelRequestStarted,
          outputObserved: modelOutputObserved || stats.tokens.output > 0,
          turnCompleted: modelTurnCompleted,
          tokens: {
            input: stats.tokens.input,
            output: stats.tokens.output,
            cacheRead: stats.tokens.cacheRead,
            cacheWrite: stats.tokens.cacheWrite,
            total: stats.tokens.total,
          },
        },
        tools: {
          started: guard.toolCalls,
          completed: guard.completedToolCalls,
          failed: guard.toolErrors,
          semanticRevision: flow.getSemanticRevision(),
          consecutiveNonProgressToolResults:
            guard.consecutiveNonProgressToolResults,
        },
        game: {
          baselineExecutions,
          diagnosticExecutions,
        },
        proposalSubmitted: flow.hasSubmittedProposal(),
      };
      assertV03ProgressMonotonic(previousProgress, snapshot);
      const partialObservation: V03PiPartialObservationV3 = {
        schemaVersion: 3,
        progress: structuredClone(snapshot),
        sessionPersisted,
        accessReceipts,
        flow: partialFlow,
      };
      progressSignature = signature;
      progressSequence = snapshot.sequence;
      previousProgress = structuredClone(snapshot);
      progressChain = progressChain
        .then(async () => {
          await options.onPartialObservationV3?.(
            structuredClone(partialObservation),
          );
          await options.onProgressV3?.(structuredClone(snapshot));
          if (
            snapshot.tools.started > 0 ||
            snapshot.tools.semanticRevision > 0 ||
            snapshot.model.tokens.total > 0
          ) {
            await options.onProgress?.(
              legacyV03ProgressSnapshot(structuredClone(snapshot)),
            );
          }
        })
        .catch((error: unknown) => {
          const failure = new PiHarnessError(
            "AGENT_FAILED",
            "Formal progress journal could not be persisted",
            { cause: error },
          );
          progressError ??= failure;
          guard.fail(progressError);
        });
    } catch (error) {
      const failure =
        error instanceof PiHarnessError
          ? error
          : new PiHarnessError(
              "AGENT_FAILED",
              "Pi v0.3 progress snapshot could not be created",
              { cause: error },
            );
      progressError ??= failure;
      guard.fail(progressError);
    }
  };

  const providerFailureFromMessages = (
    messages: readonly (typeof session.messages)[number][],
  ): PiProviderFailureError | undefined => {
    const latestAssistant = [...messages]
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
      phase: currentResponseOutputObserved ? "response_stream" : "request",
      provider: runtime.model.provider,
      model: runtime.model.id,
      stopReason:
        latestAssistant.stopReason === "aborted" ? "aborted" : "error",
    });
  };

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "turn_start") {
      currentResponseOutputObserved = false;
    } else if (event.type === "tool_execution_start") {
      guard.onToolExecutionStart(event.toolName);
    } else if (event.type === "tool_execution_end") {
      guard.onToolExecutionEnd(event.toolName, event.isError);
    } else if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (
        (update.type === "text_delta" ||
          update.type === "thinking_delta" ||
          update.type === "toolcall_delta") &&
        update.delta.length > 0
      ) {
        modelOutputObserved = true;
        currentResponseOutputObserved = true;
      } else if (
        update.type === "toolcall_end" ||
        (update.type === "text_end" && update.content.length > 0) ||
        (update.type === "thinking_end" && update.content.length > 0)
      ) {
        modelOutputObserved = true;
        currentResponseOutputObserved = true;
      }
    } else if (event.type === "turn_end") {
      modelTurnCompleted = true;
    } else if (event.type === "agent_end" && !event.willRetry) {
      const providerFailure = providerFailureFromMessages(event.messages);
      if (providerFailure !== undefined) guard.fail(providerFailure);
    }
    enqueueProgress();
  });
  const progressTimer = setInterval(enqueueProgress, 100);
  let primaryError: unknown;
  let result: V03PiDiagnosisRunResult | undefined;
  try {
    const actualNames = session.getActiveToolNames().sort();
    const expectedNames = [...activeNames].sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
      throw new PiHarnessError(
        "AGENT_FAILED",
        `Pi activated unexpected tools: ${actualNames.join(", ")}`,
      );
    }
    const requestedThinking = options.thinkingLevel ?? "medium";
    if (session.thinkingLevel !== requestedThinking) {
      throw new PiHarnessError(
        "MODEL_CONFIGURATION",
        `Pi changed thinking level from ${requestedThinking} to ${session.thinkingLevel}`,
      );
    }
    const timeoutMs = options.timeoutMs ?? 600_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    modelRequestStarted = true;
    enqueueProgress();
    const prompt = session.prompt(blindUserPrompt, {
      expandPromptTemplates: false,
    });
    await Promise.race([
      prompt,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const timeout = new PiHarnessError(
            "AGENT_TIMEOUT",
            `Pi v0.3 diagnosis timed out after ${timeoutMs}ms`,
            {
              details: {
                progressObserved:
                  modelOutputObserved ||
                  guard.toolCalls > 0 ||
                  (options.game.diagnosticExecutions ?? 0) > 0 ||
                  flow.hasSubmittedProposal(),
              },
            },
          );
          guard.fail(timeout);
          reject(guard.terminalError ?? timeout);
        }, timeoutMs);
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    enqueueProgress();
    await progressChain;
    if (guard.terminalError !== undefined) throw guard.terminalError;
    if (progressError !== undefined) throw progressError;
    const toolResultError = session.messages.find(
      (message) => message.role === "toolResult" && message.isError,
    );
    if (toolResultError?.role === "toolResult") {
      throw (
        flow.getTerminalToolViolation() ??
        new PiHarnessError(
          "INVALID_TOOL_FLOW",
          `Diagnostic tool call ${toolResultError.toolName} failed`,
        )
      );
    }
    const providerFailure = providerFailureFromMessages(session.messages);
    if (providerFailure !== undefined) throw providerFailure;
    const proposal = flow.getProposal();
    if (proposal === undefined) {
      throw new PiHarnessError(
        "PROPOSAL_MISSING",
        session.agent.state.errorMessage ?? "Pi did not submit a v0.3 proposal",
      );
    }
    if (!session.sessionFile) {
      throw new PiHarnessError("AGENT_FAILED", "Pi session was not persisted");
    }
    const stats = session.getSessionStats();
    result = {
      proposal,
      accessReceipts: flow.getReceipts(),
      wallTimeMs: Math.max(0, Math.round(performance.now() - started)),
      piSession: {
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
        provider: runtime.model.provider,
        model: runtime.model.id,
        thinkingLevel: normalizeThinking(session.thinkingLevel),
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
            runtime.model.thinkingLevelMap?.[
              normalizeThinking(session.thinkingLevel)
            ] ?? null,
        },
        promptHashes: {
          system: digestText(blindSystemPrompt),
          user: digestText(blindUserPrompt),
        },
      },
    };
  } catch (error) {
    primaryError = guard.terminalError ?? error;
    throw primaryError;
  } finally {
    clearInterval(progressTimer);
    unsubscribe();
    if (!session.isIdle) requestAbort();
    if (abortPromise !== undefined) await abortPromise;
    enqueueProgress();
    await progressChain;
    let disposeError: unknown;
    try {
      session.dispose();
    } catch (error) {
      disposeError = error;
    }
    if (primaryError === undefined) {
      if (progressError !== undefined) throw progressError;
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
    throw new PiHarnessError("AGENT_FAILED", "Pi v0.3 result was not built");
  }
  return result;
};

const response = (step: number, name: string, arguments_: UnknownRecord) =>
  fauxAssistantMessage(
    fauxToolCall(name, arguments_, { id: `v03-faux-${step}` }),
    { stopReason: "toolUse", timestamp: 1_735_689_600_000 + step },
  );

const proposalArguments = (
  base: UnknownRecord,
  mechanism: MechanismCodeV2,
  replayExecutionId: string | undefined,
  candidateExecutionIds: readonly string[],
  comparisonIds: readonly string[],
  accessReceiptIds: readonly string[],
  extraEvents: readonly UnknownRecord[] = [],
): UnknownRecord => {
  const events = [...eventRecords(base), ...extraEvents];
  return {
    schemaVersion: 3,
    proposalId: `proposal:v03:faux:${asString(base["executionId"], "executionId")}`,
    runId: asString(base["runId"], "runId"),
    fixtureId: asString(base["fixtureId"], "fixtureId"),
    capsuleId: asString(base["capsuleId"], "capsuleId"),
    baselineExecutionId: asString(base["executionId"], "executionId"),
    ...(replayExecutionId === undefined ? {} : { replayExecutionId }),
    candidateExecutionIds,
    comparisonIds,
    accessReceiptIds,
    mechanismCode: mechanism,
    summary: `Grounded deterministic proposal for ${mechanism}`,
    evidenceEventIds: events
      .map((event) => event["eventId"])
      .filter((id): id is string => typeof id === "string"),
    blockers: [],
    nextExperiment: null,
    confidence: 0,
  };
};

const proposalReceiptIds = (
  context: Context,
  options: DeterministicV03PiHarnessOptions,
): readonly string[] => [
  v03FailureBriefReceiptId(FailureBriefV1Schema.parse(options.failureBrief)),
  ...receiptIds(context),
];

const fauxSteps = (
  options: DeterministicV03PiHarnessOptions,
): FauxResponseStep[] => {
  if (options.arm === "generic") {
    return [
      response(1, "game_get_raw_baseline", {
        executionId: options.baselineExecutionId,
      }),
      response(2, "game_replay_raw_baseline", {
        executionId: options.baselineExecutionId,
      }),
      response(3, "game_list_experiments_v2", {}),
      (context) => {
        const raw = toolJson(context, "game_get_raw_baseline");
        const execution = asRecord(raw["execution"], "raw.execution");
        const mechanism = mechanismFromExecution(execution);
        const list = toolValue(context, "game_list_experiments_v2");
        const values = Array.isArray(list) ? list : [];
        const selected = candidateForMechanism(
          values.map((value, index) =>
            asRecord(value, `experiment candidate ${index}`),
          ),
          mechanism,
        );
        return response(4, "game_run_experiment_v2", {
          baselineExecutionId: options.baselineExecutionId,
          interventionId: asString(
            selected["interventionId"],
            "interventionId",
          ),
        });
      },
      (context) => {
        const raw = toolJson(context, "game_get_raw_baseline");
        const replay = toolJson(context, "game_replay_raw_baseline");
        const experiment = toolJson(context, "game_run_experiment_v2");
        const execution = asRecord(raw["execution"], "raw.execution");
        const replayExecution = asRecord(
          replay["execution"],
          "replay.execution",
        );
        const mechanism = mechanismFromExecution(execution);
        const base = {
          ...execution,
          capsuleId: options.initialCapsuleId,
        };
        const candidateEvents = Array.isArray(experiment["rawEvents"])
          ? experiment["rawEvents"].flatMap((event) =>
              event !== null &&
              typeof event === "object" &&
              !Array.isArray(event)
                ? [event as UnknownRecord]
                : [],
            )
          : [];
        return response(
          5,
          "submit_diagnosis_proposal",
          proposalArguments(
            base,
            mechanism,
            asString(replayExecution["executionId"], "replayExecutionId"),
            [asString(experiment["executionId"], "candidateExecutionId")],
            [],
            proposalReceiptIds(context, options),
            candidateEvents,
          ),
        );
      },
    ];
  }
  if (options.arm === "evidence-only") {
    return [
      response(1, "game_get_evidence_capsule_v2", {
        capsuleId: options.initialCapsuleId,
      }),
      response(2, "game_replay_execution_v2", {
        executionId: options.baselineExecutionId,
      }),
      (context) => {
        const capsule = toolJson(context, "game_get_evidence_capsule_v2");
        const replay = toolJson(context, "game_replay_execution_v2");
        const replayExecution = asRecord(
          replay["execution"],
          "replay.execution",
        );
        const base = {
          executionId: capsule["baselineExecutionId"],
          runId: capsule["runId"],
          fixtureId: capsule["fixtureId"],
          capsuleId: capsule["capsuleId"],
          events: capsule["eventChain"],
        };
        return response(
          3,
          "submit_diagnosis_proposal",
          proposalArguments(
            base,
            mechanismFromExecution(base),
            asString(replayExecution["executionId"], "replayExecutionId"),
            [],
            [],
            proposalReceiptIds(context, options),
          ),
        );
      },
    ];
  }
  return [
    response(1, "game_get_evidence_capsule_v2", {
      capsuleId: options.initialCapsuleId,
    }),
    response(2, "game_replay_execution_v2", {
      executionId: options.baselineExecutionId,
    }),
    response(3, "game_list_experiments_v2", {}),
    (context) => {
      const capsule = toolJson(context, "game_get_evidence_capsule_v2");
      const base = {
        events: capsule["eventChain"],
      };
      const mechanism = mechanismFromExecution(base);
      const candidateValue = toolValue(context, "game_list_experiments_v2");
      if (!Array.isArray(candidateValue)) {
        throw new Error("Experiment list result is not an array");
      }
      const candidates = candidateValue.map((candidate, index) =>
        asRecord(candidate, `experiment candidate ${index}`),
      );
      const selected = candidateForMechanism(candidates, mechanism);
      return response(4, "game_run_experiment_v2", {
        baselineExecutionId: options.baselineExecutionId,
        interventionId: asString(selected["interventionId"], "interventionId"),
      });
    },
    (context) => {
      const experiment = toolJson(context, "game_run_experiment_v2");
      const execution = asRecord(
        experiment["execution"],
        "experiment.execution",
      );
      return response(5, "game_compare_executions_v2", {
        baselineExecutionId: options.baselineExecutionId,
        candidateExecutionId: asString(
          execution["executionId"],
          "candidateExecutionId",
        ),
      });
    },
    (context) => {
      const capsule = toolJson(context, "game_get_evidence_capsule_v2");
      const replay = toolJson(context, "game_replay_execution_v2");
      const experiment = toolJson(context, "game_run_experiment_v2");
      const comparison = toolJson(context, "game_compare_executions_v2");
      const replayExecution = asRecord(replay["execution"], "replay.execution");
      const candidateExecution = asRecord(
        experiment["execution"],
        "experiment.execution",
      );
      const base = {
        executionId: capsule["baselineExecutionId"],
        runId: capsule["runId"],
        fixtureId: capsule["fixtureId"],
        capsuleId: capsule["capsuleId"],
        events: capsule["eventChain"],
      };
      return response(
        6,
        "submit_diagnosis_proposal",
        proposalArguments(
          base,
          mechanismFromExecution(base),
          asString(replayExecution["executionId"], "replayExecutionId"),
          [asString(candidateExecution["executionId"], "candidateExecutionId")],
          [asString(comparison["comparisonId"], "comparisonId")],
          proposalReceiptIds(context, options),
          eventRecords(candidateExecution),
        ),
      );
    },
  ];
};

export const runDeterministicV03PiDiagnosisWithSdk = async (
  options: DeterministicV03PiHarnessOptions,
): Promise<V03PiDiagnosisRunResult> => {
  const faux = fauxProvider({
    api: "chronorift-faux-v0.3",
    provider: DETERMINISTIC_PROVIDER,
    models: [
      {
        id: DETERMINISTIC_MODEL,
        name: "ChronoRift deterministic v0.3 model",
        reasoning: false,
        input: ["text"],
        contextWindow: 65_536,
        maxTokens: 8_192,
      },
    ],
    tokenSize: { min: 4, max: 4 },
  });
  const steps = fauxSteps(options);
  faux.setResponses(steps);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = modelRuntime.getModel(
    DETERMINISTIC_PROVIDER,
    DETERMINISTIC_MODEL,
  );
  if (!model)
    throw new PiHarnessError("MODEL_NOT_FOUND", "Faux v0.3 model missing");
  const result = await runV03PiDiagnosisWithRuntime(
    { ...options, thinkingLevel: "off" },
    { modelRuntime, model },
  );
  if (
    faux.state.callCount !== steps.length ||
    faux.getPendingResponseCount() !== 0
  ) {
    throw new PiHarnessError(
      "AGENT_FAILED",
      "Faux v0.3 script was not consumed exactly",
    );
  }
  return result;
};

export const runV03PiDiagnosisWithSdk = async (
  options: V03PiHarnessOptions,
): Promise<V03PiDiagnosisRunResult> => {
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  const model = modelRuntime.getModel(options.provider, options.model);
  if (!model) {
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
  return runV03PiDiagnosisWithRuntime(options, { modelRuntime, model });
};
