import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { arch, platform, type as osType } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  BenchmarkReportV2Schema,
  BenchmarkCaseEvidenceV2Schema,
  BenchmarkBaselineProgressManifestV2Schema,
  BenchmarkPublicCausalEventV2Schema,
  asBenchmarkExecutionId,
  asRunId,
  type BenchmarkExecutionId,
  type BenchmarkCellMetricsV2,
  type BenchmarkProvenanceV2,
  type BenchmarkReportV2,
  type BenchmarkSuiteSpecV2,
  type EvidenceCapsuleV2,
  type JsonValue,
  type V03TelemetryEvent,
  type V03ExecutionLog,
} from "@chronorift/domain";
import {
  scoreBenchmarkDiagnosisV2,
  type V03IdGeneratorPort,
} from "@chronorift/gamebranch";
import { doctorGodot, v03FixtureNameForId } from "@chronorift/godot-adapter";
import {
  V03BenchmarkJsonArtifactRepository,
  contentHash,
} from "@chronorift/json-artifacts";
import {
  PiHarnessError,
  assertPiModelCapabilities,
  auditV03BlindPrompt,
  createVirtualSourceAccess,
  runV03PiDiagnosis,
} from "@chronorift/pi-harness";

import { ChronoRiftV03AgentGameApi } from "./v03-agent-game-api.js";
import { classifyFormalAttemptError } from "./v03-formal-classifier.js";
import {
  executeFormalBenchmarkV2,
  type ExecuteFormalBenchmarkV2Result,
  type FormalAttemptProgressSnapshotV2,
  type FormalBenchmarkAttemptResultV2,
  type FormalBenchmarkCellV2,
} from "./v03-formal-execution.js";
import {
  assertFormalFixtureMaterialBinding,
  buildFormalBenchmarkSuiteSpecV2,
  formalCampaignForSuite,
  parseFormalBenchmarkSuiteSpecV2,
  sameFormalSuite,
} from "./v03-formal-suite.js";
import { createV03Run } from "./v03-runtime.js";

const execFileAsync = promisify(execFile);
const sha256Text = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const stableKey = (...parts: readonly string[]): string =>
  sha256Text(parts.join("\0"));

class FormalRuntimeIds implements V03IdGeneratorPort {
  private readonly counters = new Map<string, number>();

  public constructor(
    private readonly sharedPromptBasis: string,
    private readonly privateAttemptBasis: string,
  ) {}

  public next(
    kind: "branch" | "execution" | "comparison" | "capsule" | "verdict",
  ): string {
    const ordinal = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, ordinal);
    const isPromptIdentity =
      ordinal === 1 &&
      (kind === "branch" || kind === "execution" || kind === "capsule");
    return `${kind}:formal:${stableKey(
      isPromptIdentity ? this.sharedPromptBasis : this.privateAttemptBasis,
      kind,
      String(ordinal),
    )}`;
  }
}

const deterministicClock = { nowIso: (): string => "2026-01-01T00:00:00.000Z" };

const isContained = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
};

const readNeutralSource = async (
  root: string,
  sourcePath: string,
): Promise<string> => {
  const resolvedRoot = resolve(root);
  const path = resolve(resolvedRoot, sourcePath);
  if (!isContained(resolvedRoot, path)) {
    throw new Error("Fixture oracle source path escapes its source root");
  }
  return readFile(path, "utf8");
};

const diagnosticCode = (
  code: string,
):
  | "progress_timeout"
  | "proposal_missing"
  | "invalid_proposal"
  | "invalid_tool_flow"
  | "budget_exhausted" => {
  if (code === "timeout_after_progress") return "progress_timeout";
  if (code === "proposal_missing") return "proposal_missing";
  if (code === "invalid_diagnosis") return "invalid_proposal";
  if (code.includes("budget")) return "budget_exhausted";
  return "invalid_tool_flow";
};

const invalidCode = (
  code: string,
):
  | "auth_failure"
  | "model_incompatible"
  | "non_retryable_http_4xx"
  | "harness_failure"
  | "godot_failure"
  | "schema_failure" => {
  if (code === "auth_failed") return "auth_failure";
  if (code.startsWith("model_")) return "model_incompatible";
  if (code === "provider_non_retryable_4xx") {
    return "non_retryable_http_4xx";
  }
  if (code === "invalid_game_result") return "godot_failure";
  return "harness_failure";
};

const infraCode = (
  code: string,
):
  | "no_progress_timeout"
  | "connection_error"
  | "http_408"
  | "http_429"
  | "http_5xx" =>
  code === "connection"
    ? "connection_error"
    : (code as "no_progress_timeout" | "http_408" | "http_429" | "http_5xx");

const errorManifest = (
  cell: FormalBenchmarkCellV2,
  audit: JsonValue,
  caseEvidence: JsonValue,
  error: unknown,
  progressObserved: boolean,
): JsonValue => ({
  schemaVersion: 2,
  cellId: cell.cellId,
  fixtureId: cell.fixtureId,
  arm: cell.arm,
  repetition: cell.repetition,
  promptAudit: audit,
  caseEvidence,
  progressObserved,
  error: {
    name: error instanceof Error ? error.name : "UnknownError",
    code: error instanceof PiHarnessError ? error.code : "unknown",
    message: error instanceof Error ? error.message : String(error),
  },
});

type SafeEvidenceScalar = boolean | number | null;

const safeEvidenceScalar = (
  value: JsonValue,
  label: string,
): SafeEvidenceScalar => {
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  throw new Error(`${label} is not a publishable scalar`);
};

const safeFinalState = (
  values: V03ExecutionLog["finalState"]["values"],
): Readonly<Record<string, SafeEvidenceScalar>> =>
  Object.fromEntries(
    Object.entries(values).map(([path, value]) => [
      path,
      safeEvidenceScalar(value, `Final state ${path}`),
    ]),
  );

const publicCausalEvent = (
  event: Exclude<V03TelemetryEvent, { readonly kind: "log" }>,
  role:
    | "trigger"
    | "delivery"
    | "state_transition"
    | "lifecycle"
    | "spatial_sample"
    | "pending_effect"
    | "causal_ancestor"
    | "agent_citation",
  includedEventIds: ReadonlySet<string>,
): JsonValue => {
  const common = {
    eventId: event.eventId,
    role,
    seq: event.seq,
    tick: event.tick,
    simTimeUs: event.simTimeUs,
    causedByEventId:
      event.causedByEventId !== undefined &&
      includedEventIds.has(event.causedByEventId)
        ? event.causedByEventId
        : null,
    contentHash: contentHash(event as unknown as JsonValue),
  };
  switch (event.kind) {
    case "input":
      return BenchmarkPublicCausalEventV2Schema.parse({
        ...common,
        kind: event.kind,
        action: event.action,
        target: event.target ?? null,
        requestedTick: event.requestedTick,
        realizedTick: event.realizedTick,
      }) as unknown as JsonValue;
    case "signal":
      return BenchmarkPublicCausalEventV2Schema.parse({
        ...common,
        kind: event.kind,
        source: event.source,
        name: event.name,
        sourceEntity: event.sourceEntity ?? null,
      }) as unknown as JsonValue;
    case "signal_delivery":
      return BenchmarkPublicCausalEventV2Schema.parse({
        ...common,
        kind: event.kind,
        source: event.source,
        name: event.name,
        receiver: event.receiver,
        delivered: event.delivered,
        failureReason: event.failureReason ?? null,
        sourceEntity: event.sourceEntity ?? null,
        receiverEntity: event.receiverEntity ?? null,
      }) as unknown as JsonValue;
    case "property_changed":
      return BenchmarkPublicCausalEventV2Schema.parse({
        ...common,
        kind: event.kind,
        path: event.path,
        before: safeEvidenceScalar(event.before, `${event.path} before`),
        after: safeEvidenceScalar(event.after, `${event.path} after`),
        entity: event.entity ?? null,
      }) as unknown as JsonValue;
    case "entity_lifecycle":
      return BenchmarkPublicCausalEventV2Schema.parse({
        ...common,
        kind: event.kind,
        action: event.action,
        entity: event.entity,
      }) as unknown as JsonValue;
    case "spatial_sample":
      return BenchmarkPublicCausalEventV2Schema.parse({
        ...common,
        kind: event.kind,
        entity: event.entity,
        position: event.position,
      }) as unknown as JsonValue;
    case "pending_effect":
      return BenchmarkPublicCausalEventV2Schema.parse({
        ...common,
        kind: event.kind,
        action: event.action,
        effectId: event.effectId,
        target: event.target,
        resolvedTarget: event.resolvedTarget ?? null,
        dueTick: event.dueTick,
        reason: event.reason ?? null,
      }) as unknown as JsonValue;
  }
};

const publicCapsuleCausality = (
  capsule: EvidenceCapsuleV2,
): {
  readonly evidenceLinks: readonly JsonValue[];
  readonly causalEvents: readonly JsonValue[];
  readonly omittedRuntimeLogCount: number;
} => {
  const eventsById = new Map(
    capsule.eventChain.map((event) => [event.eventId, event] as const),
  );
  const evidenceLinks = capsule.evidenceLinks.flatMap((link) => {
    const event = eventsById.get(link.eventId);
    if (event === undefined) {
      throw new Error("Capsule evidence link does not resolve");
    }
    return event.kind === "log" || link.role === "runtime_log"
      ? []
      : [{ role: link.role, eventId: link.eventId }];
  });
  const includedEventIds = new Set(evidenceLinks.map((link) => link.eventId));
  const includeAncestors = (eventId: string): void => {
    const event = eventsById.get(eventId as V03TelemetryEvent["eventId"]);
    if (event?.causedByEventId === undefined) return;
    const ancestor = eventsById.get(event.causedByEventId);
    if (ancestor === undefined || ancestor.kind === "log") return;
    if (!includedEventIds.has(ancestor.eventId)) {
      includedEventIds.add(ancestor.eventId);
      includeAncestors(ancestor.eventId);
    }
  };
  for (const eventId of [...includedEventIds]) includeAncestors(eventId);
  const roles = new Map(evidenceLinks.map((link) => [link.eventId, link.role]));
  const causalEvents = capsule.eventChain.flatMap((event) => {
    if (!includedEventIds.has(event.eventId) || event.kind === "log") return [];
    return [
      publicCausalEvent(
        event,
        roles.get(event.eventId) ?? "causal_ancestor",
        includedEventIds,
      ),
    ];
  });
  return {
    evidenceLinks,
    causalEvents,
    omittedRuntimeLogCount: capsule.evidenceLinks.filter((link) => {
      const event = eventsById.get(link.eventId);
      return link.role === "runtime_log" || event?.kind === "log";
    }).length,
  };
};

const publicExecutionCausality = (
  execution: V03ExecutionLog,
  citedEventIds: ReadonlySet<string>,
): JsonValue[] => {
  const eventsById = new Map(
    execution.events.map((event) => [event.eventId, event] as const),
  );
  const includedEventIds = new Set(
    execution.events
      .filter(
        (event) => citedEventIds.has(event.eventId) && event.kind !== "log",
      )
      .map((event) => event.eventId),
  );
  const includeAncestors = (eventId: string): void => {
    const event = eventsById.get(eventId as V03TelemetryEvent["eventId"]);
    if (event?.causedByEventId === undefined) return;
    const ancestor = eventsById.get(event.causedByEventId);
    if (ancestor === undefined || ancestor.kind === "log") return;
    if (!includedEventIds.has(ancestor.eventId)) {
      includedEventIds.add(ancestor.eventId);
      includeAncestors(ancestor.eventId);
    }
  };
  for (const eventId of [...includedEventIds]) includeAncestors(eventId);
  return execution.events.flatMap((event) => {
    if (!includedEventIds.has(event.eventId) || event.kind === "log") return [];
    return [
      publicCausalEvent(
        event,
        citedEventIds.has(event.eventId) ? "agent_citation" : "causal_ancestor",
        includedEventIds,
      ),
    ];
  });
};

const executionEvidence = (
  execution: V03ExecutionLog,
  baselineTimelineDigest: string,
  citedEventIds: ReadonlySet<string>,
): JsonValue => ({
  executionId: execution.executionId,
  contractId: execution.contractId,
  checkpointId: execution.startCheckpointId,
  inputTraceId: execution.inputTraceId,
  evaluationStatus: execution.evaluation.status,
  evaluation: execution.evaluation as unknown as JsonValue,
  timelineDigest: execution.timelineDigest,
  contentHash: contentHash(execution as unknown as JsonValue),
  restoreReceiptHash: contentHash(
    execution.restoreReceipt as unknown as JsonValue,
  ),
  controlReceiptHash: contentHash(
    execution.controlReceipt as unknown as JsonValue,
  ),
  stepReceiptsHash: contentHash(execution.stepReceipts as unknown as JsonValue),
  observationHealthHash: contentHash(
    execution.observationHealth as unknown as JsonValue,
  ),
  finalStateHash: contentHash(execution.finalState as unknown as JsonValue),
  finalState: { values: safeFinalState(execution.finalState.values) },
  causalEvents: publicExecutionCausality(execution, citedEventIds),
  runtimeFingerprintHash:
    execution.runtimeFingerprint === undefined
      ? null
      : contentHash(execution.runtimeFingerprint as unknown as JsonValue),
  timelineMatchesBaseline: execution.timelineDigest === baselineTimelineDigest,
  restoreReceipt: execution.restoreReceipt as unknown as JsonValue,
  controlReceipt: execution.controlReceipt as unknown as JsonValue,
  stepReceipts: execution.stepReceipts as unknown as JsonValue,
  observationHealth: execution.observationHealth as unknown as JsonValue,
});

async function buildCaseEvidence(
  context: Awaited<ReturnType<typeof createV03Run>>,
  diagnosis: Awaited<ReturnType<typeof runV03PiDiagnosis>> | null,
): Promise<JsonValue> {
  const [checkpoint, inputTrace] = await Promise.all([
    context.repository.getCheckpoint(
      context.baselineExecution.startCheckpointId,
    ),
    context.repository.getInputTrace(context.baselineExecution.inputTraceId),
  ]);
  const replay =
    diagnosis?.proposal.replayExecutionId === undefined
      ? null
      : await context.repository.getExecution(
          diagnosis.proposal.replayExecutionId,
        );
  const candidates =
    diagnosis === null
      ? []
      : await Promise.all(
          diagnosis.proposal.candidateExecutionIds.map((id) =>
            context.repository.getExecution(id),
          ),
        );
  const comparisons =
    diagnosis === null
      ? []
      : await Promise.all(
          diagnosis.proposal.comparisonIds.map((id) =>
            context.repository.getComparison(id),
          ),
        );
  const publicCausality = publicCapsuleCausality(context.evidenceCapsule);
  const citedEventIds = new Set(diagnosis?.proposal.evidenceEventIds ?? []);
  return BenchmarkCaseEvidenceV2Schema.parse({
    schemaVersion: 2,
    contract: {
      contractId: context.contract.contractId,
      contentHash: contentHash(context.contract as unknown as JsonValue),
    },
    checkpoint: {
      checkpointId: checkpoint.checkpointId,
      contentHash: contentHash(checkpoint.content as unknown as JsonValue),
      certificateHash:
        checkpoint.content.certificate === undefined
          ? null
          : contentHash(checkpoint.content.certificate as unknown as JsonValue),
      certificate:
        checkpoint.content.certificate === undefined
          ? null
          : {
              level: checkpoint.content.certificate.level,
              captureConsistencyModel:
                checkpoint.content.certificate.captureConsistencyModel,
              coveredStateDomains:
                checkpoint.content.certificate.coveredStateDomains,
              missingStateDomains:
                checkpoint.content.certificate.missingStateDomains,
              externalDependencies:
                checkpoint.content.certificate.externalDependencies,
              rngDomains: checkpoint.content.certificate.rngDomains,
              pendingAsyncOperations:
                checkpoint.content.certificate.pendingAsyncOperations,
              portability: checkpoint.content.certificate.portability,
              limitations: checkpoint.content.certificate.limitations,
            },
    },
    inputTrace: {
      inputTraceId: inputTrace.inputTraceId,
      contentHash: contentHash(inputTrace as unknown as JsonValue),
    },
    capsule: {
      capsuleId: context.evidenceCapsule.capsuleId,
      contentHash: contentHash(context.evidenceCapsule as unknown as JsonValue),
      timelineDigest: context.evidenceCapsule.timelineDigest,
      eventChainHash: contentHash(
        context.evidenceCapsule.eventChain as unknown as JsonValue,
      ),
      evidenceLinks: publicCausality.evidenceLinks,
      causalEvents: publicCausality.causalEvents,
      omittedRuntimeLogCount: publicCausality.omittedRuntimeLogCount,
      expected: context.evidenceCapsule.expected,
      actual: context.evidenceCapsule.actual,
      eventLossDetected: context.evidenceCapsule.eventLossDetected,
      limitationsHash: contentHash([
        ...context.evidenceCapsule.knownLimitations,
      ]),
    },
    baseline: executionEvidence(
      context.baselineExecution,
      context.baselineExecution.timelineDigest,
      citedEventIds,
    ),
    replay:
      replay === null
        ? null
        : executionEvidence(
            replay,
            context.baselineExecution.timelineDigest,
            citedEventIds,
          ),
    candidates: candidates.map((candidate) =>
      executionEvidence(
        candidate,
        context.baselineExecution.timelineDigest,
        citedEventIds,
      ),
    ),
    comparisons: comparisons.map((comparison) => ({
      comparisonId: comparison.comparisonId,
      baselineExecutionId: comparison.baselineExecutionId,
      candidateExecutionId: comparison.candidateExecutionId,
      interventionId: comparison.interventionId,
      baselineOutcome: comparison.baselineOutcome,
      candidateOutcome: comparison.candidateOutcome,
      comparable: comparison.comparable,
      blockersHash: contentHash([...comparison.blockers]),
      firstDivergenceTick: comparison.firstDivergenceTick,
      contentHash: contentHash(comparison as unknown as JsonValue),
    })),
    accessReceipts: diagnosis?.accessReceipts ?? [],
  }) as unknown as JsonValue;
}

const sourceScore = (
  cell: FormalBenchmarkCellV2,
  suite: BenchmarkSuiteSpecV2,
  diagnosis: Awaited<ReturnType<typeof runV03PiDiagnosis>>,
): { readonly location: boolean | null; readonly grounded: boolean } => {
  const suspected = diagnosis.proposal.suspectedSource;
  if (suspected === undefined || suspected.symbol === undefined) {
    return { location: null, grounded: false };
  }
  const suspectedSymbol = suspected.symbol;
  const expected = suite.fixtures.find(
    (fixture) => fixture.fixtureId === cell.fixtureId,
  )?.expectedSource;
  if (expected === undefined) throw new Error("Missing Fixture source oracle");
  const cited = new Set(diagnosis.proposal.accessReceiptIds);
  const grounded = diagnosis.accessReceipts.some(
    (receipt) =>
      cited.has(receipt.receiptId) &&
      (receipt.accessKind === "source_read" ||
        receipt.accessKind === "source_search") &&
      receipt.sourceCoverage.some(
        (coverage) =>
          coverage.virtualPath === suspected.path &&
          coverage.coveredSymbols.includes(suspectedSymbol),
      ),
  );
  return {
    location: grounded
      ? suspected.path === expected.virtualPath &&
        suspectedSymbol === expected.symbol
      : null,
    grounded,
  };
};

export interface RunFormalBenchmarkOptions {
  readonly cwd: string;
  readonly specPath: string;
  readonly artifactRoot: string;
  readonly godotBin?: string | undefined;
  readonly resumeExecutionId?: string | undefined;
  readonly onExecutionSelected?:
    ((executionId: BenchmarkExecutionId) => void | Promise<void>) | undefined;
}

interface AttemptExecutorOptions {
  readonly cwd: string;
  readonly artifactRoot: string;
  readonly godotBin?: string | undefined;
  readonly suite: BenchmarkSuiteSpecV2;
  readonly executionId: ReturnType<typeof asBenchmarkExecutionId>;
}

const createAttemptExecutor =
  (options: AttemptExecutorOptions) =>
  async (
    cell: FormalBenchmarkCellV2,
    ordinal: number,
    recordProgress: (
      snapshot: FormalAttemptProgressSnapshotV2,
    ) => Promise<void>,
  ): Promise<FormalBenchmarkAttemptResultV2> => {
    const fixtureName = v03FixtureNameForId(cell.fixtureId);
    const investigationBasis = stableKey(
      options.suite.definitionId,
      cell.fixtureId,
      String(cell.repetition),
    );
    const attemptRoot = resolve(
      options.artifactRoot,
      "formal-cell-runs",
      stableKey(options.executionId, cell.cellId),
      String(ordinal),
    );
    const runId = asRunId(`run:formal:${investigationBasis}`);
    const started = Date.now();
    const context = await createV03Run({
      cwd: options.cwd,
      fixture: fixtureName,
      artifactRoot: attemptRoot,
      runId,
      ids: new FormalRuntimeIds(
        investigationBasis,
        stableKey(investigationBasis, cell.cellId, String(ordinal)),
      ),
      clock: deterministicClock,
      ...(options.godotBin === undefined ? {} : { godotBin: options.godotBin }),
    });
    let agentProgressSnapshotObserved = false;
    let lastToolCalls = 0;
    let lastTokens: BenchmarkCellMetricsV2["tokens"] = {
      input: 0,
      output: 0,
      total: 0,
    };
    await recordProgress({
      observedAt: new Date().toISOString(),
      validationStage: "baseline_completed_unvalidated",
      metrics: {
        gameExecutions: 1,
        toolCalls: lastToolCalls,
        wallTimeMs: Math.max(0, Date.now() - started),
        tokens: lastTokens,
      },
      rawManifest: BenchmarkBaselineProgressManifestV2Schema.parse({
        schemaVersion: 2,
        stage: "baseline_completed",
        cellId: cell.cellId,
        fixtureId: cell.fixtureId,
        arm: cell.arm,
        repetition: cell.repetition,
        baselineExecutionId: context.baselineExecution.executionId,
        baselineTimelineDigest: context.baselineExecution.timelineDigest,
        gameExecutions: 1,
        progressObserved: true,
        error: { code: "process_interrupted_after_progress" },
      }),
    });
    const promptAudit = auditV03BlindPrompt(context.failureBrief);
    const sourceText = await readNeutralSource(
      context.preparedFixture.sourceDirectory,
      context.preparedFixture.oracle.sourcePath,
    );
    const fixtureSpec = options.suite.fixtures.find(
      (fixture) => fixture.fixtureId === cell.fixtureId,
    );
    if (fixtureSpec === undefined) {
      throw new Error("Formal cell Fixture is absent from its suite");
    }
    const materialHashes = assertFormalFixtureMaterialBinding(fixtureSpec, {
      contract: context.contract as unknown as JsonValue,
      inputTrace: context.preparedFixture.fixture
        .inputTrace as unknown as JsonValue,
      interventionCatalog: context.preparedFixture.fixture
        .experiments as unknown as JsonValue,
      oracle: context.preparedFixture.oracle as unknown as JsonValue,
      sourceText,
    });
    if (
      fixtureSpec.expectedSource.virtualPath !== "case/main.gd" ||
      fixtureSpec.expectedSource.symbol !==
        context.preparedFixture.oracle.sourceSymbol
    ) {
      throw new Error("Formal Fixture source oracle does not match the suite");
    }
    const sourceAccess = createVirtualSourceAccess({
      files: [{ path: "case/main.gd", content: sourceText }],
    });
    const formalAudit: JsonValue = {
      ...promptAudit,
      baselineTimelineDigest: context.baselineExecution.timelineDigest,
      checkpointId: context.baselineExecution.startCheckpointId,
      checkpointHash: contentHash(
        context.preparedFixture
          .initialCheckpointContent as unknown as JsonValue,
      ),
      contractId: context.contract.contractId,
      contractHash: materialHashes.contractHash,
      inputTraceId: context.baselineExecution.inputTraceId,
      inputTraceHash: materialHashes.inputTraceHash,
      runtimeFingerprintHash: contentHash(
        (context.baselineExecution.runtimeFingerprint ??
          context.preparedFixture.environment
            .runtimeFingerprint) as unknown as JsonValue,
      ),
      sourceViewHash: materialHashes.aliasMapHash,
      experimentCatalogHash: materialHashes.interventionCatalogHash,
      oracleHash: materialHashes.oracleHash,
    };
    const game = new ChronoRiftV03AgentGameApi(context);
    const initialCaseEvidence = await buildCaseEvidence(context, null);
    await recordProgress({
      observedAt: new Date().toISOString(),
      validationStage: "fixture_material_validated",
      metrics: {
        gameExecutions: game.gameExecutions,
        toolCalls: lastToolCalls,
        wallTimeMs: Math.max(0, Date.now() - started),
        tokens: lastTokens,
      },
      rawManifest: {
        schemaVersion: 2,
        cellId: cell.cellId,
        fixtureId: cell.fixtureId,
        arm: cell.arm,
        repetition: cell.repetition,
        promptAudit: formalAudit,
        caseEvidence: initialCaseEvidence,
        progressObserved: true,
        error: { code: "process_interrupted_after_progress" },
      },
    });
    const remainingTimeoutMs =
      options.suite.budgets.timeoutMs - Math.max(0, Date.now() - started);
    if (remainingTimeoutMs <= 0) {
      return {
        status: "diagnostic_failure",
        progressObserved: true,
        code: "budget_exhausted",
        message: "Formal cell budget was exhausted during setup",
        rawManifest: errorManifest(
          cell,
          formalAudit,
          initialCaseEvidence,
          new Error("cell setup budget exhausted"),
          true,
        ),
        metrics: {
          gameExecutions: game.gameExecutions,
          toolCalls: 0,
          wallTimeMs: Math.max(0, Date.now() - started),
          tokens: { input: 0, output: 0, total: 0 },
        },
      };
    }
    try {
      const diagnosis = await runV03PiDiagnosis({
        cwd: options.cwd,
        runDir: context.runDirectory,
        arm: cell.arm,
        initialCapsuleId: context.evidenceCapsule.capsuleId,
        baselineExecutionId: context.baselineExecution.executionId,
        failureBrief: context.failureBrief,
        game,
        source: sourceAccess,
        provider: options.suite.provider,
        model: options.suite.model,
        thinkingLevel: "max",
        sdkRetry: false,
        receiptIssuedAt: deterministicClock.nowIso(),
        timeoutMs: remainingTimeoutMs,
        onProgress: async (snapshot) => {
          agentProgressSnapshotObserved = true;
          lastToolCalls = snapshot.toolCalls;
          lastTokens = snapshot.tokens;
          const progressMetrics: BenchmarkCellMetricsV2 = {
            gameExecutions: game.gameExecutions,
            toolCalls: snapshot.toolCalls,
            wallTimeMs: Math.max(0, Date.now() - started),
            tokens: snapshot.tokens,
          };
          await recordProgress({
            observedAt: new Date().toISOString(),
            validationStage: "agent_progress",
            metrics: progressMetrics,
            rawManifest: {
              schemaVersion: 2,
              cellId: cell.cellId,
              fixtureId: cell.fixtureId,
              arm: cell.arm,
              repetition: cell.repetition,
              promptAudit: formalAudit,
              caseEvidence: initialCaseEvidence,
              progressObserved: true,
              error: { code: "process_interrupted_after_progress" },
            },
          });
        },
      });
      if (
        diagnosis.piSession.promptHashes.system !== promptAudit.systemHash ||
        diagnosis.piSession.promptHashes.user !== promptAudit.userHash ||
        diagnosis.piSession.thinkingLevel !== "max" ||
        diagnosis.piSession.modelMetadata.contextWindow !== 1_000_000 ||
        diagnosis.piSession.modelMetadata.maxTokens !== 128_000 ||
        diagnosis.piSession.modelMetadata.mappedThinkingValue !== "max" ||
        game.gameExecutions > options.suite.budgets.maxGameExecutions
      ) {
        return {
          status: "invalid",
          progressObserved: true,
          code: "harness_failure",
          message: "Formal prompt, model, or execution-budget audit failed",
          metrics: {
            gameExecutions: game.gameExecutions,
            toolCalls: diagnosis.piSession.stats.toolCalls,
            wallTimeMs: Math.max(0, Date.now() - started),
            tokens: diagnosis.piSession.stats.tokens,
          },
        };
      }
      const verdict = await context.gameBranch.concludeV3(
        diagnosis.proposal,
        diagnosis.accessReceipts,
      );
      const sourceAssessment = sourceScore(cell, options.suite, diagnosis);
      const caseEvidence = await buildCaseEvidence(context, diagnosis);
      const score = scoreBenchmarkDiagnosisV2({
        proposalId: diagnosis.proposal.proposalId,
        candidateExecutionIds: diagnosis.proposal.candidateExecutionIds,
        accessReceiptIds: diagnosis.proposal.accessReceiptIds,
        expectedMechanism: cell.expectedMechanism,
        proposedMechanism: diagnosis.proposal.mechanismCode,
        verdict: verdict.status,
        sourceLocationCorrect: sourceAssessment.location,
        sourceGrounded: sourceAssessment.grounded,
        confidence: diagnosis.proposal.confidence,
      });
      const rawManifest: JsonValue = {
        schemaVersion: 2,
        cellId: cell.cellId,
        fixtureId: cell.fixtureId,
        arm: cell.arm,
        repetition: cell.repetition,
        runId: context.runId,
        promptAudit: formalAudit,
        caseEvidence,
        piSession: diagnosis.piSession as unknown as JsonValue,
        proposal: diagnosis.proposal as unknown as JsonValue,
        accessReceipts: diagnosis.accessReceipts as unknown as JsonValue,
        verdict: verdict as unknown as JsonValue,
        gameExecutions: game.gameExecutions,
      };
      return {
        status: "completed",
        progressObserved: true,
        rawManifest,
        score,
        metrics: {
          gameExecutions: game.gameExecutions,
          toolCalls: diagnosis.piSession.stats.toolCalls,
          wallTimeMs: Math.max(0, Date.now() - started),
          tokens: diagnosis.piSession.stats.tokens,
        },
      };
    } catch (error) {
      const progressObserved =
        game.progressObserved || agentProgressSnapshotObserved;
      const classified = classifyFormalAttemptError(error, {
        progressObserved,
      });
      const metrics: BenchmarkCellMetricsV2 = {
        gameExecutions: game.gameExecutions,
        toolCalls: lastToolCalls,
        wallTimeMs: Math.max(0, Date.now() - started),
        tokens: lastTokens,
      };
      if (classified.status === "infrastructure_failure") {
        return {
          status: "infra_failure",
          progressObserved: false,
          code: infraCode(classified.code),
          message: classified.message,
          metrics,
        };
      }
      if (classified.status === "diagnostic_failure") {
        return {
          status: "diagnostic_failure",
          progressObserved: true,
          code: diagnosticCode(classified.code),
          message: classified.message,
          rawManifest: errorManifest(
            cell,
            formalAudit,
            await buildCaseEvidence(context, null),
            error,
            progressObserved,
          ),
          metrics,
        };
      }
      return {
        status: "invalid",
        progressObserved,
        code: invalidCode(classified.code),
        message: classified.message,
        metrics,
      };
    }
  };

const recordOf = (
  value: JsonValue,
  label: string,
): Record<string, JsonValue> => {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} is not an object`);
  }
  return value;
};

const auditSignature = (manifest: JsonValue): string => {
  const raw = recordOf(manifest, "raw attempt manifest");
  const audit = recordOf(raw["promptAudit"] ?? null, "prompt audit");
  const fields = [
    audit["failureBriefHash"],
    audit["failureBriefReceiptId"],
    audit["systemHash"],
    audit["userHash"],
    audit["baselineTimelineDigest"],
    audit["checkpointId"],
    audit["checkpointHash"],
    audit["contractId"],
    audit["contractHash"],
    audit["inputTraceId"],
    audit["inputTraceHash"],
    audit["runtimeFingerprintHash"],
    audit["sourceViewHash"],
    audit["experimentCatalogHash"],
    audit["oracleHash"],
  ];
  if (fields.some((field) => typeof field !== "string")) {
    throw new Error("Prompt audit contains a non-string hash or receipt ID");
  }
  const piSession = raw["piSession"];
  if (piSession !== undefined) {
    const parsedSession = recordOf(piSession, "Pi session");
    const parsed = recordOf(
      parsedSession["promptHashes"] ?? null,
      "Pi prompt hashes",
    );
    if (
      parsed["system"] !== audit["systemHash"] ||
      parsed["user"] !== audit["userHash"]
    ) {
      throw new Error("Pi prompt hashes contradict the pre-call prompt audit");
    }
  }
  return fields
    .map((field) => {
      if (typeof field !== "string") {
        throw new Error("Prompt audit field is not a string");
      }
      return field;
    })
    .join("\0");
};

async function assertPromptFairness(
  report: BenchmarkReportV2,
  repository: V03BenchmarkJsonArtifactRepository,
): Promise<void> {
  if (report.status !== "complete") return;
  const groups = new Map<string, Set<string>>();
  const counts = new Map<string, number>();
  for (const cell of report.cells) {
    const selected = report.attempts.find(
      (attempt) => attempt.attemptId === cell.selectedAttemptId,
    );
    if (selected === undefined) throw new Error("Selected attempt is missing");
    const record = await repository.getAttemptFinished(
      report.suite.definitionId,
      report.executionId,
      cell.cellId,
      selected.ordinal,
      selected.attemptId,
    );
    if (record?.rawManifest === null || record === null) {
      throw new Error(
        "Complete benchmark cell lacks a prompt-audited manifest",
      );
    }
    const group = `${cell.fixtureId}\0${cell.repetition}`;
    const signatures = groups.get(group) ?? new Set<string>();
    signatures.add(auditSignature(record.rawManifest));
    groups.set(group, signatures);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  if (
    groups.size !== 12 ||
    [...groups.entries()].some(
      ([group, signatures]) => signatures.size !== 1 || counts.get(group) !== 3,
    )
  ) {
    throw new Error(
      "Formal benchmark arms did not receive byte-identical prompts",
    );
  }
}

const commandText = async (
  cwd: string,
  ...args: readonly string[]
): Promise<string> => {
  const [command, ...rest] = args;
  if (command === undefined) throw new Error("Missing command");
  const result = await execFileAsync(command, rest, { cwd, encoding: "utf8" });
  return result.stdout.trim();
};

async function formalProvenance(
  cwd: string,
  godotBin: string | undefined,
  model: Awaited<ReturnType<typeof assertPiModelCapabilities>>,
  suite: BenchmarkSuiteSpecV2,
): Promise<BenchmarkProvenanceV2> {
  const campaign = formalCampaignForSuite(suite);
  const [
    gitCommit,
    status,
    freezeCommit,
    lockfile,
    pnpmVersion,
    piPackage,
    doctor,
  ] = await Promise.all([
    commandText(cwd, "git", "rev-parse", "HEAD"),
    commandText(cwd, "git", "status", "--porcelain"),
    commandText(cwd, "git", "rev-list", "-n", "1", campaign.freezeTag),
    readFile(resolve(cwd, "pnpm-lock.yaml")),
    commandText(cwd, "corepack", "pnpm", "--version"),
    readFile(resolve(cwd, "packages/pi-harness/package.json"), "utf8"),
    doctorGodot({
      cwd,
      ...(godotBin === undefined ? {} : { godotBin }),
    }),
  ]);
  if (status.length > 0 || freezeCommit !== gitCommit) {
    throw new Error(
      `Formal benchmark requires a clean checkout exactly at ${campaign.freezeTag}`,
    );
  }
  const pi = JSON.parse(piPackage) as {
    dependencies?: Record<string, unknown>;
  };
  const piVersion = pi.dependencies?.["@earendil-works/pi-coding-agent"];
  if (typeof piVersion !== "string") {
    throw new Error("Pinned Pi package version is unavailable");
  }
  return {
    gitCommit,
    freezeTag: campaign.freezeTag,
    dirty: false,
    lockfileHash: sha256Text(lockfile),
    piPackageVersion: piVersion,
    nodeVersion: process.version,
    pnpmVersion,
    godotVersion: doctor.version,
    godotExecutableHash: sha256Text(await readFile(doctor.binary)),
    resolvedModelName: model.name,
    resolvedContextWindow: 1_000_000,
    resolvedMaxTokens: 128_000,
    mappedThinkingLevel: "max",
    requestedThinkingLevel: "max",
    os: osType(),
    arch: arch(),
    platform: platform(),
  };
}

export async function runFormalBenchmark(
  options: RunFormalBenchmarkOptions,
): Promise<ExecuteFormalBenchmarkV2Result> {
  const suite = parseFormalBenchmarkSuiteSpecV2(
    JSON.parse(await readFile(resolve(options.specPath), "utf8")) as unknown,
  );
  const expected = await buildFormalBenchmarkSuiteSpecV2({
    cwd: options.cwd,
    artifactRoot: resolve(options.artifactRoot, "formal-preflight"),
    ...(suite.campaign === undefined
      ? {}
      : { campaign: suite.campaign.campaignId }),
    ...(options.godotBin === undefined ? {} : { godotBin: options.godotBin }),
  });
  if (!sameFormalSuite(suite, expected)) {
    throw new Error(
      "Committed formal suite does not match current subject or runner",
    );
  }
  const model = await assertPiModelCapabilities({
    provider: suite.provider,
    model: suite.model,
    contextWindow: suite.modelRequirements.contextWindow,
    maxTokens: suite.modelRequirements.maxTokens,
    thinkingLevel: "max",
    mappedThinkingValue: suite.modelRequirements.thinkingLevelMapMax,
  });
  const provenance = await formalProvenance(
    options.cwd,
    options.godotBin,
    model,
    suite,
  );
  const executionId = asBenchmarkExecutionId(
    options.resumeExecutionId ?? `benchmark-execution:${randomUUID()}`,
  );
  const repository = new V03BenchmarkJsonArtifactRepository(
    options.artifactRoot,
  );
  return executeFormalBenchmarkV2({
    suite,
    executionId,
    provenance,
    repository,
    allowRecoveryCycle: options.resumeExecutionId !== undefined,
    runAttempt: createAttemptExecutor({
      cwd: options.cwd,
      artifactRoot: options.artifactRoot,
      suite,
      executionId,
      ...(options.godotBin === undefined ? {} : { godotBin: options.godotBin }),
    }),
    recover: () => Promise.resolve(),
    nowIso: () => new Date().toISOString(),
    sleep: (milliseconds) =>
      new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
    ...(options.onExecutionSelected === undefined
      ? {}
      : {
          onExecutionSelected: async (selectedExecutionId) =>
            options.onExecutionSelected?.(selectedExecutionId),
        }),
    validateBeforePersist: (report) => assertPromptFairness(report, repository),
  });
}

export const parsePublishedBenchmarkReport = (
  input: unknown,
): BenchmarkReportV2 => BenchmarkReportV2Schema.parse(input);
