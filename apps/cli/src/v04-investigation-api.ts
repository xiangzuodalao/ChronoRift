import { randomUUID } from "node:crypto";

import {
  INVESTIGATION_CAPABILITIES_V1,
  parseDiagnosisProposalDraftV1,
  parseInvestigationCapabilityManifestV1,
  parseResourceHandleV1,
  type CapsuleAccessResultV1,
  type ClaimPolicyCapabilityV1,
  type CompareExecutionsInputV1,
  type CompareExecutionsResultV1,
  type DiagnosisProposalDraftV1,
  type EventHandleResultV1,
  type GetCapsuleInputV1,
  type InvestigationApiV1,
  type ListInterventionsInputV1,
  type ListInterventionsResultV1,
  type ReplayExecutionInputV1,
  type ReplayExecutionResultV1,
  type ResourceHandleV1,
  type RunInterventionInputV1,
  type RunInterventionResultV1,
  type SourceReadInputV1,
  type SourceReadResultV1,
  type SourceSearchInputV1,
  type SourceSearchResultV1,
  type SubmitProposalResultV1,
} from "@chronorift/agent-protocol";
import {
  DiagnosisProposalV4Schema,
  EvidenceAccessReceiptV2Schema,
  asProposalId,
  type EvidenceAccessKindV1,
  type EvidenceAccessReceiptV2,
  type JsonValue,
  type SourceCoverageV1,
  type V03ExecutionLog,
  type V03TelemetryEvent,
} from "@chronorift/domain";
import {
  v04ContentHash,
  v04EvidenceAccessReceiptIdFor,
} from "@chronorift/gamebranch";
import type { RestrictedSourceAccess } from "@chronorift/pi-harness";

import type { V04RunContext } from "./v04-runtime.js";

type HandleKind =
  | "capsule"
  | "execution"
  | "intervention"
  | "comparison"
  | "receipt"
  | "event"
  | "proposal";

interface HandleEntry {
  readonly kind: HandleKind;
  readonly identity: string;
  readonly value: unknown;
}

export class V04InvestigationApiError extends Error {
  public override readonly name = "V04InvestigationApiError";

  public constructor(
    public readonly code:
      | "INVALID_HANDLE"
      | "INVALID_TOOL_FLOW"
      | "BUDGET_EXHAUSTED"
      | "INVALID_RUNTIME_RESULT"
      | "INVALID_PROPOSAL",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface V04InvestigationApiOptions {
  readonly source: RestrictedSourceAccess;
  readonly nowIso?: (() => string) | undefined;
  readonly nextProposalId?: (() => string) | undefined;
  /** Test seam; production defaults to an independently random handle. */
  readonly nextHandle?: (() => string) | undefined;
}

const symbolsFromLine = (line: string): readonly string[] => {
  const match = /^\s*(?:func|function)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/u.exec(
    line,
  );
  return match?.[1] === undefined ? [] : [match[1]];
};

const readCoverage = (result: {
  readonly path: string;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
}): readonly SourceCoverageV1[] => [
  {
    virtualPath: result.path,
    startLine: result.startLine,
    endLine: result.endLine,
    coveredSymbols: [
      ...new Set(result.content.split("\n").flatMap(symbolsFromLine)),
    ],
  },
];

const searchCoverage = (result: {
  readonly matches: readonly {
    readonly path: string;
    readonly line: number;
    readonly text: string;
  }[];
}): readonly SourceCoverageV1[] =>
  result.matches.map((match) => ({
    virtualPath: match.path,
    startLine: match.line,
    endLine: match.line,
    coveredSymbols: symbolsFromLine(match.text),
  }));

const claimPolicyCapabilitiesFor = (
  context: V04RunContext,
): readonly ClaimPolicyCapabilityV1[] => {
  const active = context.gameBranch.listClaimPolicyContracts();
  const activeIdentities = active.map(
    ({ policyId, policyVersion, mechanismId, assertionSchemaId }) => ({
      policyId,
      policyVersion,
      mechanismId,
      assertionSchemaId,
    }),
  );
  if (
    v04ContentHash(activeIdentities) !==
    v04ContentHash(
      context.investigation.claimPolicyManifest
        .policies as unknown as JsonValue,
    )
  ) {
    throw new V04InvestigationApiError(
      "INVALID_RUNTIME_RESULT",
      "Agent claim contracts do not match the frozen Claim Policy manifest",
    );
  }
  return active.map((policy) => ({
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    mechanismId: policy.mechanismId,
    assertionSchemaId: policy.assertionSchemaId,
    mechanismDescription: policy.mechanismDescription,
    additionalProperties: false,
    evidenceRequirements: [...policy.evidenceRequirements],
    assertionFields: policy.assertionFields.map((field) => ({
      name: field.name,
      type: field.type,
      required: true,
      description: field.description,
      ...(field.minimum === undefined ? {} : { minimum: field.minimum }),
      ...(field.allowedValues === undefined
        ? {}
        : { allowedValues: [...field.allowedValues] }),
    })),
  }));
};

/**
 * Session-scoped bridge between opaque Agent handles and canonical GameBranch
 * facts. The bridge injects investigation scope, persists every evidence
 * receipt, and never lets the Agent manufacture artifact IDs.
 */
export class V04InvestigationApi implements InvestigationApiV1 {
  public readonly manifest;
  public readonly initialCapsuleHandle: ResourceHandleV1;

  readonly #entries = new Map<ResourceHandleV1, HandleEntry>();
  readonly #handlesByKey = new Map<string, ResourceHandleV1>();
  readonly #receipts: EvidenceAccessReceiptV2[] = [];
  readonly #accessKeys = new Set<string>();
  readonly #replayExecutionIds = new Set<string>();
  readonly #candidateExecutionIds = new Set<string>();
  readonly #comparisonIds = new Set<string>();
  readonly #nowIso: () => string;
  readonly #nextProposalId: () => string;
  readonly #nextHandle: () => string;
  readonly #baselineExecutionHandle: ResourceHandleV1;
  #toolCalls = 0;
  #replayCalls = 0;
  #strictReplayCompleted = false;
  #interventionCalls = 0;
  #comparisonCalls = 0;
  #sourceReadCalls = 0;
  #sourceSearchCalls = 0;
  #sourceReadLines = 0;
  #sourceSearchResults = 0;
  #capsuleRead = false;
  #catalogRead = false;
  #proposalSubmitted = false;
  #toolInFlight = false;

  public constructor(
    private readonly context: V04RunContext,
    private readonly options: V04InvestigationApiOptions,
  ) {
    this.#nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.#nextProposalId =
      options.nextProposalId ?? (() => `proposal:v04:${randomUUID()}`);
    this.#nextHandle =
      options.nextHandle ?? (() => `rh_${randomUUID().replaceAll("-", "")}`);
    this.manifest = parseInvestigationCapabilityManifestV1({
      schemaVersion: 1,
      protocolVersion: "chronorift.investigation.v1",
      capabilities: [...INVESTIGATION_CAPABILITIES_V1],
      claimPolicies: claimPolicyCapabilitiesFor(context),
      budgets: {
        maxToolCalls: 16,
        maxReplayCalls: 1,
        maxInterventions:
          context.investigation.experimentBudget.maxInterventions,
        maxComparisons: context.investigation.experimentBudget.maxInterventions,
        maxSourceReads: 2,
        maxSourceSearches: 2,
        maxSourceReadLines: 500,
        maxSourceSearchResults: 100,
      },
    });
    this.initialCapsuleHandle = this.handle(
      "capsule",
      context.evidenceCapsule.capsuleId,
      context.evidenceCapsule,
    );
    this.#baselineExecutionHandle = this.handle(
      "execution",
      context.baselineExecution.executionId,
      context.baselineExecution,
    );
  }

  public getReceipts(): readonly EvidenceAccessReceiptV2[] {
    return structuredClone(this.#receipts);
  }

  private handle(
    kind: HandleKind,
    identity: string,
    value: unknown,
  ): ResourceHandleV1 {
    const key = `${kind}\0${identity}`;
    const existing = this.#handlesByKey.get(key);
    if (existing !== undefined) return existing;
    const handle = parseResourceHandleV1(this.#nextHandle());
    if (this.#entries.has(handle)) {
      throw new V04InvestigationApiError(
        "INVALID_HANDLE",
        "Handle generator returned a duplicate Session capability",
      );
    }
    this.#entries.set(handle, { kind, identity, value });
    this.#handlesByKey.set(key, handle);
    return handle;
  }

  private resolve<T>(handle: ResourceHandleV1, kind: HandleKind): T {
    const entry = this.#entries.get(handle);
    if (entry === undefined || entry.kind !== kind) {
      throw new V04InvestigationApiError(
        "INVALID_HANDLE",
        `Handle does not resolve to an in-scope ${kind}`,
      );
    }
    return entry.value as T;
  }

  private identity(handle: ResourceHandleV1, kind: HandleKind): string {
    const entry = this.#entries.get(handle);
    if (entry === undefined || entry.kind !== kind) {
      throw new V04InvestigationApiError(
        "INVALID_HANDLE",
        `Handle does not resolve to an in-scope ${kind}`,
      );
    }
    return entry.identity;
  }

  private async call<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.#proposalSubmitted) {
      throw new V04InvestigationApiError(
        "INVALID_TOOL_FLOW",
        "The investigation is closed after proposal submission",
      );
    }
    if (this.#toolInFlight) {
      throw new V04InvestigationApiError(
        "INVALID_TOOL_FLOW",
        "Concurrent investigation tool calls are not allowed",
      );
    }
    if (this.#toolCalls >= this.manifest.budgets.maxToolCalls) {
      throw new V04InvestigationApiError(
        "BUDGET_EXHAUSTED",
        "Investigation tool-call budget exhausted",
      );
    }
    this.#toolCalls += 1;
    this.#toolInFlight = true;
    try {
      return await operation();
    } finally {
      this.#toolInFlight = false;
    }
  }

  private eventHandles(
    events: readonly V03TelemetryEvent[],
  ): readonly EventHandleResultV1[] {
    return events.map((event) => ({
      eventHandle: this.handle("event", event.eventId, event),
      event: structuredClone(event),
    }));
  }

  private async receipt(
    accessKind: EvidenceAccessKindV1,
    resourceId: string,
    request: JsonValue,
    content: JsonValue,
    sourceCoverage: readonly SourceCoverageV1[] = [],
  ): Promise<ResourceHandleV1> {
    const requestHash = v04ContentHash(request);
    const accessKey = `${accessKind}\0${requestHash}`;
    if (this.#accessKeys.has(accessKey)) {
      throw new V04InvestigationApiError(
        "INVALID_TOOL_FLOW",
        `Repeated ${accessKind} access is not allowed`,
      );
    }
    const body = {
      schemaVersion: 2 as const,
      runId: this.context.runId,
      investigationId: this.context.investigationId,
      accessKind,
      resourceId,
      requestHash,
      contentHash: v04ContentHash(content),
      sourceCoverage,
    };
    const value = EvidenceAccessReceiptV2Schema.parse({
      ...body,
      receiptId: v04EvidenceAccessReceiptIdFor(body),
      issuedAt: this.#nowIso(),
    });
    await this.context.repository.putEvidenceAccessReceipt(value);
    this.#accessKeys.add(accessKey);
    this.#receipts.push(value);
    return this.handle("receipt", value.receiptId, value);
  }

  public getCapsule(input: GetCapsuleInputV1): Promise<CapsuleAccessResultV1> {
    return this.call(async () => {
      const capsule = this.resolve<V04RunContext["evidenceCapsule"]>(
        input.capsuleHandle,
        "capsule",
      );
      if (
        input.capsuleHandle !== this.initialCapsuleHandle ||
        this.#capsuleRead
      ) {
        throw new V04InvestigationApiError(
          "INVALID_TOOL_FLOW",
          "The initial Evidence Capsule may be read exactly once",
        );
      }
      this.#capsuleRead = true;
      const accessReceiptHandle = await this.receipt(
        "capsule",
        capsule.capsuleId,
        { capsuleId: capsule.capsuleId },
        capsule as unknown as JsonValue,
      );
      return {
        capsuleHandle: input.capsuleHandle,
        baselineExecutionHandle: this.#baselineExecutionHandle,
        accessReceiptHandle,
        capsule: structuredClone(capsule),
        events: this.eventHandles(capsule.eventChain),
      };
    });
  }

  public replayExecution(
    input: ReplayExecutionInputV1,
  ): Promise<ReplayExecutionResultV1> {
    return this.call(async () => {
      if (!this.#capsuleRead) {
        throw new V04InvestigationApiError(
          "INVALID_TOOL_FLOW",
          "Read the Evidence Capsule before replay",
        );
      }
      const execution = this.resolve<V03ExecutionLog>(
        input.executionHandle,
        "execution",
      );
      if (
        input.executionHandle !== this.#baselineExecutionHandle ||
        execution.executionId !== this.context.baselineExecution.executionId
      ) {
        throw new V04InvestigationApiError(
          "INVALID_HANDLE",
          "Only the protected baseline can be replayed",
        );
      }
      if (this.#replayCalls >= this.manifest.budgets.maxReplayCalls) {
        throw new V04InvestigationApiError(
          "BUDGET_EXHAUSTED",
          "Replay budget exhausted",
        );
      }
      this.#replayCalls += 1;
      const result = await this.context.gameBranch.replayExecution(
        execution.executionId,
      );
      if (
        result.execution.executionId === execution.executionId ||
        result.sourceDigest !== execution.timelineDigest ||
        result.replayDigest !== result.execution.timelineDigest ||
        result.matches !== (result.sourceDigest === result.replayDigest)
      ) {
        throw new V04InvestigationApiError(
          "INVALID_RUNTIME_RESULT",
          "Replay result is inconsistent with the protected baseline",
        );
      }
      const executionHandle = this.handle(
        "execution",
        result.execution.executionId,
        result.execution,
      );
      const content = {
        execution: result.execution,
        matches: result.matches,
        sourceDigest: result.sourceDigest,
        replayDigest: result.replayDigest,
      };
      const accessReceiptHandle = await this.receipt(
        "replay",
        result.execution.executionId,
        { executionId: execution.executionId },
        content as unknown as JsonValue,
      );
      const events = this.eventHandles(result.execution.events);
      this.#replayExecutionIds.add(result.execution.executionId);
      this.#strictReplayCompleted = result.matches;
      return {
        executionHandle,
        accessReceiptHandle,
        execution: structuredClone(result.execution),
        events,
        matches: result.matches,
        sourceDigest: result.sourceDigest,
        replayDigest: result.replayDigest,
      };
    });
  }

  public listInterventions(
    input: ListInterventionsInputV1,
  ): Promise<ListInterventionsResultV1> {
    return this.call(async () => {
      void input;
      if (!this.#capsuleRead) {
        throw new V04InvestigationApiError(
          "INVALID_TOOL_FLOW",
          "Read the Evidence Capsule before listing interventions",
        );
      }
      if (this.#catalogRead) {
        throw new V04InvestigationApiError(
          "INVALID_TOOL_FLOW",
          "The intervention catalog may be listed exactly once",
        );
      }
      this.#catalogRead = true;
      const interventions = this.context.gameBranch.listInterventions();
      const accessReceiptHandle = await this.receipt(
        "experiment",
        "intervention-catalog",
        {},
        interventions as unknown as JsonValue,
      );
      return {
        accessReceiptHandle,
        interventions: interventions.map((candidate) => ({
          interventionHandle: this.handle(
            "intervention",
            candidate.interventionId,
            candidate,
          ),
          candidate: structuredClone(candidate),
        })),
      };
    });
  }

  public runIntervention(
    input: RunInterventionInputV1,
  ): Promise<RunInterventionResultV1> {
    return this.call(async () => {
      if (!this.#catalogRead) {
        throw new V04InvestigationApiError(
          "INVALID_TOOL_FLOW",
          "List interventions before running one",
        );
      }
      if (!this.#strictReplayCompleted) {
        throw new V04InvestigationApiError(
          "INVALID_TOOL_FLOW",
          "Complete one successful strict replay before running an intervention",
        );
      }
      const baseline = this.resolve<V03ExecutionLog>(
        input.baselineExecutionHandle,
        "execution",
      );
      if (input.baselineExecutionHandle !== this.#baselineExecutionHandle) {
        throw new V04InvestigationApiError(
          "INVALID_HANDLE",
          "Interventions must branch from the protected baseline",
        );
      }
      const intervention = this.resolve<
        V04RunContext["investigation"]["interventions"][number]
      >(input.interventionHandle, "intervention");
      if (this.#interventionCalls >= this.manifest.budgets.maxInterventions) {
        throw new V04InvestigationApiError(
          "BUDGET_EXHAUSTED",
          "Intervention budget exhausted",
        );
      }
      this.#interventionCalls += 1;
      const result = await this.context.gameBranch.runIntervention(
        baseline.executionId,
        intervention.interventionId,
      );
      const executionHandle = this.handle(
        "execution",
        result.execution.executionId,
        result.execution,
      );
      this.#candidateExecutionIds.add(result.execution.executionId);
      const content = {
        interventionId: intervention.interventionId,
        execution: result.execution,
      };
      const accessReceiptHandle = await this.receipt(
        "experiment",
        result.execution.executionId,
        {
          baselineExecutionId: baseline.executionId,
          interventionId: intervention.interventionId,
        },
        content as unknown as JsonValue,
      );
      return {
        interventionHandle: input.interventionHandle,
        executionHandle,
        accessReceiptHandle,
        execution: structuredClone(result.execution),
        events: this.eventHandles(result.execution.events),
      };
    });
  }

  public compareExecutions(
    input: CompareExecutionsInputV1,
  ): Promise<CompareExecutionsResultV1> {
    return this.call(async () => {
      const baseline = this.resolve<V03ExecutionLog>(
        input.baselineExecutionHandle,
        "execution",
      );
      const candidate = this.resolve<V03ExecutionLog>(
        input.candidateExecutionHandle,
        "execution",
      );
      if (
        input.baselineExecutionHandle !== this.#baselineExecutionHandle ||
        !this.#candidateExecutionIds.has(candidate.executionId)
      ) {
        throw new V04InvestigationApiError(
          "INVALID_HANDLE",
          "Comparison handles are outside the controlled experiment set",
        );
      }
      if (this.#comparisonCalls >= this.manifest.budgets.maxComparisons) {
        throw new V04InvestigationApiError(
          "BUDGET_EXHAUSTED",
          "Comparison budget exhausted",
        );
      }
      this.#comparisonCalls += 1;
      const comparison = await this.context.gameBranch.compareExecutions(
        baseline.executionId,
        candidate.executionId,
      );
      const comparisonHandle = this.handle(
        "comparison",
        comparison.comparisonId,
        comparison,
      );
      this.#comparisonIds.add(comparison.comparisonId);
      const accessReceiptHandle = await this.receipt(
        "comparison",
        comparison.comparisonId,
        {
          baselineExecutionId: baseline.executionId,
          candidateExecutionId: candidate.executionId,
        },
        comparison as unknown as JsonValue,
      );
      return {
        comparisonHandle,
        accessReceiptHandle,
        comparison: structuredClone(comparison),
      };
    });
  }

  public readSource(input: SourceReadInputV1): Promise<SourceReadResultV1> {
    return this.call(async () => {
      if (this.#sourceReadCalls >= this.manifest.budgets.maxSourceReads) {
        throw new V04InvestigationApiError(
          "BUDGET_EXHAUSTED",
          "Source-read budget exhausted",
        );
      }
      const remainingLines =
        this.manifest.budgets.maxSourceReadLines - this.#sourceReadLines;
      if (remainingLines <= 0 || (input.limit ?? 0) > remainingLines) {
        throw new V04InvestigationApiError(
          "BUDGET_EXHAUSTED",
          "Requested source-read range exceeds the remaining line budget",
        );
      }
      const effectiveLimit = input.limit ?? Math.min(200, remainingLines);
      this.#sourceReadCalls += 1;
      const request = {
        path: input.path,
        ...(input.offset === undefined ? {} : { offset: input.offset }),
        limit: effectiveLimit,
      };
      const result = await this.options.source.read(request);
      const lineCount = result.endLine - result.startLine + 1;
      if (lineCount < 1 || lineCount > remainingLines) {
        throw new V04InvestigationApiError(
          "INVALID_RUNTIME_RESULT",
          "Source adapter returned a range outside the remaining line budget",
        );
      }
      this.#sourceReadLines += lineCount;
      const accessReceiptHandle = await this.receipt(
        "source_read",
        result.path,
        request,
        result as unknown as JsonValue,
        readCoverage(result),
      );
      return { accessReceiptHandle, ...result };
    });
  }

  public searchSource(
    input: SourceSearchInputV1,
  ): Promise<SourceSearchResultV1> {
    return this.call(async () => {
      if (this.#sourceSearchCalls >= this.manifest.budgets.maxSourceSearches) {
        throw new V04InvestigationApiError(
          "BUDGET_EXHAUSTED",
          "Source-search budget exhausted",
        );
      }
      const remainingResults =
        this.manifest.budgets.maxSourceSearchResults -
        this.#sourceSearchResults;
      if (remainingResults <= 0 || (input.maxResults ?? 0) > remainingResults) {
        throw new V04InvestigationApiError(
          "BUDGET_EXHAUSTED",
          "Requested source search exceeds the remaining result budget",
        );
      }
      const effectiveMaxResults =
        input.maxResults ?? Math.min(100, remainingResults);
      this.#sourceSearchCalls += 1;
      const request = {
        query: input.query,
        ...(input.path === undefined ? {} : { path: input.path }),
        ...(input.includeSuffixes === undefined
          ? {}
          : { includeSuffixes: input.includeSuffixes }),
        ...(input.caseSensitive === undefined
          ? {}
          : { caseSensitive: input.caseSensitive }),
        maxResults: effectiveMaxResults,
      };
      const result = await this.options.source.search(request);
      if (result.matches.length > remainingResults) {
        throw new V04InvestigationApiError(
          "INVALID_RUNTIME_RESULT",
          "Source adapter exceeded the remaining search-result budget",
        );
      }
      this.#sourceSearchResults += result.matches.length;
      const accessReceiptHandle = await this.receipt(
        "source_search",
        input.path ?? ".",
        request,
        result as unknown as JsonValue,
        searchCoverage(result),
      );
      return { accessReceiptHandle, ...result };
    });
  }

  public submitProposal(
    input: DiagnosisProposalDraftV1,
  ): Promise<SubmitProposalResultV1> {
    return this.call(() => {
      let draft: DiagnosisProposalDraftV1;
      try {
        draft = parseDiagnosisProposalDraftV1(input);
      } catch (error) {
        throw new V04InvestigationApiError(
          "INVALID_PROPOSAL",
          "Diagnosis proposal draft failed strict validation",
          { cause: error },
        );
      }
      if (
        draft.capsuleHandle !== this.initialCapsuleHandle ||
        draft.baselineExecutionHandle !== this.#baselineExecutionHandle
      ) {
        throw new V04InvestigationApiError(
          "INVALID_HANDLE",
          "Proposal scope handles do not match the active investigation",
        );
      }
      const replayExecutionId =
        draft.replayExecutionHandle === undefined
          ? undefined
          : this.identity(draft.replayExecutionHandle, "execution");
      if (
        replayExecutionId !== undefined &&
        !this.#replayExecutionIds.has(replayExecutionId)
      ) {
        throw new V04InvestigationApiError(
          "INVALID_HANDLE",
          "Proposal replay handle was not returned by this Session",
        );
      }
      const candidateExecutionIds = draft.candidateExecutionHandles.map(
        (handle) => this.identity(handle, "execution"),
      );
      if (
        candidateExecutionIds.some((id) => !this.#candidateExecutionIds.has(id))
      ) {
        throw new V04InvestigationApiError(
          "INVALID_HANDLE",
          "Proposal candidate handle was not returned by this Session",
        );
      }
      const comparisonIds = draft.comparisonHandles.map((handle) =>
        this.identity(handle, "comparison"),
      );
      if (comparisonIds.some((id) => !this.#comparisonIds.has(id))) {
        throw new V04InvestigationApiError(
          "INVALID_HANDLE",
          "Proposal comparison handle was not returned by this Session",
        );
      }
      const proposal = DiagnosisProposalV4Schema.parse({
        schemaVersion: 4,
        proposalId: asProposalId(this.#nextProposalId()),
        runId: this.context.runId,
        investigationId: this.context.investigationId,
        capsuleId: this.context.evidenceCapsule.capsuleId,
        baselineExecutionId: this.context.baselineExecution.executionId,
        ...(replayExecutionId === undefined ? {} : { replayExecutionId }),
        candidateExecutionIds,
        comparisonIds,
        accessReceiptIds: draft.accessReceiptHandles.map((handle) =>
          this.identity(handle, "receipt"),
        ),
        claim: draft.claim,
        summary: draft.summary,
        evidenceEventIds: draft.evidenceEventHandles.map((handle) =>
          this.identity(handle, "event"),
        ),
        ...(draft.suspectedSource === undefined
          ? {}
          : { suspectedSource: draft.suspectedSource }),
        blockers: draft.blockers,
        nextExperiment: draft.nextExperiment,
        confidence: draft.confidence,
      });
      this.#proposalSubmitted = true;
      return {
        accepted: true,
        proposalHandle: this.handle("proposal", proposal.proposalId, proposal),
        proposal,
      };
    });
  }
}
