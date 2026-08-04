import { createHash } from "node:crypto";
import { join } from "node:path";

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
import { Type } from "typebox";

import { PiHarnessError } from "../errors.js";
import type {
  DeterministicV03PiHarnessOptions,
  V03ExperimentResult,
  V03PiDiagnosisRunResult,
  V03PiHarnessOptions,
  V03ReplayResult,
} from "../v03-types.js";
import {
  buildV03BlindSystemPrompt,
  buildV03BlindUserPrompt,
  v03FailureBriefReceiptId,
} from "./v03-prompt.js";

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
  private readonly accessKeys = new Set<string>();
  private readonly failureBrief: FailureBriefV1;
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
    );
  }

  public get progressObserved(): boolean {
    return (
      this.genericBaseline !== undefined ||
      this.capsule !== undefined ||
      this.replays.length > 0 ||
      this.experiments !== undefined ||
      this.experimentResults.length > 0 ||
      this.comparisons.length > 0 ||
      this.sourceCalls > 0 ||
      this.proposal !== undefined
    );
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
    return structuredClone(receipt);
  }

  private accessed<T>(
    accessKind: EvidenceAccessKindV1,
    resourceId: string,
    request: unknown,
    data: T,
    sourceCoverage: readonly SourceCoverageV1[] = [],
  ): { readonly data: T; readonly accessReceipt: EvidenceAccessReceiptV1 } {
    return {
      data,
      accessReceipt: this.recordAccess(
        accessKind,
        resourceId,
        request,
        data,
        sourceCoverage,
      ),
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
    return this.accessed(
      "source_read",
      data.path,
      sourceRequest,
      data,
      readCoverage(data),
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
    return this.accessed(
      "source_search",
      request.path ?? ".",
      sourceRequest,
      data,
      searchCoverage(data),
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
    const parsed = DiagnosisProposalV3Schema.safeParse(raw);
    if (!parsed.success) {
      throw new PiHarnessError(
        "INVALID_DIAGNOSIS",
        "Diagnosis proposal failed strict validation",
        { cause: parsed.error },
      );
    }
    const proposal = parsed.data;
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
    this.proposal = structuredClone(proposal);
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

const toolsFor = (
  flow: V03ToolFlow,
  arm: BenchmarkArmV1,
): readonly ToolDefinition[] => {
  const tools: ToolDefinition[] = [];
  if (arm === "generic") {
    tools.push(
      defineTool({
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
      defineTool({
        name: "game_replay_raw_baseline",
        label: "Replay raw baseline",
        description:
          "Rerun the baseline and return its raw runtime transcript.",
        parameters: Type.Object({ executionId: IdSchema }, strictObject),
        execute: async (_id, params) =>
          toolResult(
            await flow.runTool(() => flow.rawReplay(params.executionId)),
          ),
      }),
    );
  } else {
    tools.push(
      defineTool({
        name: "game_get_evidence_capsule_v2",
        label: "Get Evidence Capsule v2",
        description: "Read the immutable causal evidence Capsule.",
        parameters: Type.Object({ capsuleId: IdSchema }, strictObject),
        execute: async (_id, params) =>
          toolResult(
            await flow.runTool(() => flow.capsuleById(params.capsuleId)),
          ),
      }),
      defineTool({
        name: "game_replay_execution_v2",
        label: "Strict replay",
        description: "Restore the frozen checkpoint and replay the baseline.",
        parameters: Type.Object({ executionId: IdSchema }, strictObject),
        execute: async (_id, params) =>
          toolResult(await flow.runTool(() => flow.replay(params.executionId))),
      }),
    );
  }
  if (arm !== "evidence-only") {
    tools.push(
      defineTool({
        name: "game_list_experiments_v2",
        label: "List experiments",
        description: "List the two allowlisted single-variable experiments.",
        parameters: Type.Object({}, strictObject),
        execute: async () =>
          toolResult(await flow.runTool(() => flow.listExperiments())),
      }),
      defineTool({
        name: "game_run_experiment_v2",
        label: "Run experiment",
        description:
          "Run one allowlisted experiment; at most two are permitted.",
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
      defineTool({
        name: "game_compare_executions_v2",
        label: "Compare executions",
        description:
          "Validate lineage, realized controls, outcomes, and divergence.",
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
    defineTool({
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
    defineTool({
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
    defineTool({
      name: "submit_diagnosis_proposal",
      label: "Submit diagnosis",
      description: "Submit a proposal; only the Harness can emit a verdict.",
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

const runWithRuntime = async (
  options: DeterministicV03PiHarnessOptions,
  runtime: { readonly modelRuntime: ModelRuntime; readonly model: Model<Api> },
): Promise<V03PiDiagnosisRunResult> => {
  const arm = BenchmarkArmV1Schema.parse(options.arm);
  const flow = new V03ToolFlow(options);
  const customTools = toolsFor(flow, arm);
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
  const started = Date.now();
  let progressChain = Promise.resolve();
  let progressError: unknown;
  let progressSignature = "";
  const enqueueProgress = (): void => {
    if (options.onProgress === undefined) return;
    const stats = session.getSessionStats();
    if (
      !flow.progressObserved &&
      stats.toolCalls === 0 &&
      stats.tokens.total === 0
    ) {
      return;
    }
    const signature = `${flow.progressObserved}\0${stats.toolCalls}\0${stats.tokens.input}\0${stats.tokens.output}\0${stats.tokens.total}`;
    if (signature === progressSignature) return;
    progressSignature = signature;
    const snapshot = {
      progressObserved: flow.progressObserved,
      toolCalls: stats.toolCalls,
      tokens: {
        input: stats.tokens.input,
        output: stats.tokens.output,
        total: stats.tokens.total,
      },
      wallTimeMs: Math.max(0, Date.now() - started),
    };
    progressChain = progressChain
      .then(() => options.onProgress?.(snapshot))
      .then(() => undefined)
      .catch((error: unknown) => {
        progressError = error;
      });
  };
  const progressTimer = setInterval(enqueueProgress, 100);
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
    const timeoutMs = options.timeoutMs ?? 300_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      session.prompt(blindUserPrompt, { expandPromptTemplates: false }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const stats = session.getSessionStats();
          void session.abort();
          reject(
            new PiHarnessError(
              "AGENT_TIMEOUT",
              `Pi v0.3 diagnosis timed out after ${timeoutMs}ms`,
              {
                details: {
                  progressObserved:
                    flow.progressObserved ||
                    stats.toolCalls > 0 ||
                    stats.tokens.total > 0,
                },
              },
            ),
          );
        }, timeoutMs);
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    enqueueProgress();
    await progressChain;
    if (progressError !== undefined) {
      throw new PiHarnessError(
        "AGENT_FAILED",
        "Formal progress journal could not be persisted",
        { cause: progressError },
      );
    }
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
    return {
      proposal,
      accessReceipts: flow.getReceipts(),
      wallTimeMs: Date.now() - started,
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
  } finally {
    clearInterval(progressTimer);
    enqueueProgress();
    await progressChain;
    session.dispose();
    if (progressError !== undefined) {
      throw new PiHarnessError(
        "AGENT_FAILED",
        "Formal progress journal could not be persisted",
        { cause: progressError },
      );
    }
  }
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
  const result = await runWithRuntime(
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
    throw new PiHarnessError(
      "MODEL_NOT_FOUND",
      `Pi model ${options.provider}/${options.model} is not registered`,
    );
  }
  const available = await modelRuntime.getAvailable(options.provider);
  if (!available.some((candidate) => candidate.id === options.model)) {
    throw new PiHarnessError(
      "MODEL_UNAVAILABLE",
      `Pi model ${options.provider}/${options.model} is not authenticated`,
    );
  }
  return runWithRuntime(options, { modelRuntime, model });
};
