import { createHash } from "node:crypto";

import {
  BenchmarkAttemptProgressV3Schema,
  BenchmarkCellAttemptV3Schema,
  BenchmarkCellResultV3Schema,
  BenchmarkCellScoringProofV3Schema,
  BenchmarkCellScoreV3Schema,
  BenchmarkRawAttemptManifestV3Schema,
  BenchmarkReportV3Schema,
  BenchmarkSuiteSpecV3Schema,
  asBenchmarkAttemptId,
  asBenchmarkCellId,
  asBenchmarkDefinitionId,
  asBenchmarkSuiteId,
  type BenchmarkAggregateV3,
  type BenchmarkArmAggregateV3,
  type BenchmarkArmV1,
  type BenchmarkAttemptId,
  type BenchmarkAttemptProgressStateV3,
  type BenchmarkAttemptProgressV3,
  type BenchmarkCellAttemptV3,
  type BenchmarkCellId,
  type BenchmarkCellResultV3,
  type BenchmarkCellScoringProofV3,
  type BenchmarkCellScoreV3,
  type BenchmarkExecutionId,
  type BenchmarkFixtureSpecV3,
  type BenchmarkGateEvaluationV3,
  type BenchmarkReportV3,
  type BenchmarkRawAttemptManifestV3,
  type BenchmarkSuiteSpecV3,
  type EvidenceAccessReceiptId,
  type EvidenceAccessReceiptV1,
  type BenchmarkCaseEvidenceV2,
  type BenchmarkPublicCausalEventV2,
  type EventId,
  type ExecutionId,
  type FixtureId,
  type JsonValue,
  type MechanismCodeV2,
  type ProposalId,
} from "@chronorift/domain";

import { canonicalStringify } from "./canonical.js";

const digest = (value: JsonValue): string =>
  createHash("sha256").update(canonicalStringify(value)).digest("hex");

const textDigest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

type CreateBenchmarkSuiteSpecV3Base = Omit<
  BenchmarkSuiteSpecV3,
  "suiteId" | "definitionId" | "suiteHash" | "fixtures"
>;

export interface CreateBenchmarkSuiteSpecV3Input extends CreateBenchmarkSuiteSpecV3Base {
  readonly fixtures: readonly BenchmarkFixtureSpecV3[];
}

const suiteHashBasis = (input: CreateBenchmarkSuiteSpecV3Input): JsonValue => {
  const { subjectHash, runnerHash, ...basis } = input;
  void subjectHash;
  void runnerHash;
  return { ...basis, fixtures: [...input.fixtures] };
};

export function createBenchmarkSuiteSpecV3(
  input: CreateBenchmarkSuiteSpecV3Input,
): BenchmarkSuiteSpecV3 {
  const suiteHash = digest(suiteHashBasis(input));
  const suiteId = asBenchmarkSuiteId(`benchmark-suite:${suiteHash}`);
  const definitionId = asBenchmarkDefinitionId(
    `benchmark-definition:${digest({
      suiteHash,
      subjectHash: input.subjectHash,
      runnerHash: input.runnerHash,
    })}`,
  );
  return BenchmarkSuiteSpecV3Schema.parse({
    ...input,
    suiteId,
    definitionId,
    suiteHash,
  });
}

export function assertBenchmarkSuiteSpecV3Integrity(
  input: BenchmarkSuiteSpecV3,
): BenchmarkSuiteSpecV3 {
  const spec = BenchmarkSuiteSpecV3Schema.parse(input);
  const { suiteId, definitionId, suiteHash, ...basis } = spec;
  void suiteId;
  void definitionId;
  void suiteHash;
  const expected = createBenchmarkSuiteSpecV3(basis);
  if (
    expected.suiteId !== spec.suiteId ||
    expected.suiteHash !== spec.suiteHash ||
    expected.definitionId !== spec.definitionId
  ) {
    throw new Error("Benchmark V3 suite hash or definition ID is invalid");
  }
  return spec;
}

export function benchmarkCellIdV3(
  specInput: BenchmarkSuiteSpecV3,
  fixtureId: FixtureId,
  arm: BenchmarkArmV1,
  repetition: number,
): BenchmarkCellId {
  const spec = BenchmarkSuiteSpecV3Schema.parse(specInput);
  if (!spec.fixtures.some((fixture) => fixture.fixtureId === fixtureId)) {
    throw new Error("Benchmark V3 cell Fixture is not in the suite");
  }
  if (!spec.arms.includes(arm)) {
    throw new Error("Benchmark V3 cell arm is not in the suite");
  }
  if (!Number.isInteger(repetition) || repetition < 1 || repetition > 3) {
    throw new Error("Benchmark V3 cell repetition is outside the suite");
  }
  return asBenchmarkCellId(
    `benchmark-cell:${digest({
      definitionId: spec.definitionId,
      fixtureId,
      arm,
      repetition,
    })}`,
  );
}

export interface BenchmarkOrderedCellV3 {
  readonly cellId: BenchmarkCellId;
  readonly fixtureId: FixtureId;
  readonly arm: BenchmarkArmV1;
  readonly repetition: number;
}

export function benchmarkCellOrderV3(
  specInput: BenchmarkSuiteSpecV3,
): readonly BenchmarkOrderedCellV3[] {
  const spec = assertBenchmarkSuiteSpecV3Integrity(specInput);
  const blocks = spec.fixtures.flatMap((fixture) =>
    Array.from({ length: spec.repetitions }, (_, index) => ({
      fixtureId: fixture.fixtureId,
      repetition: index + 1,
    })),
  );
  blocks.sort((left, right) =>
    textDigest(
      `${spec.orderSeed}\0block\0${left.fixtureId}\0${left.repetition}`,
    ).localeCompare(
      textDigest(
        `${spec.orderSeed}\0block\0${right.fixtureId}\0${right.repetition}`,
      ),
    ),
  );
  return blocks.flatMap((block) =>
    [...spec.arms]
      .sort((left, right) =>
        textDigest(
          `${spec.orderSeed}\0arm\0${block.fixtureId}\0${block.repetition}\0${left}`,
        ).localeCompare(
          textDigest(
            `${spec.orderSeed}\0arm\0${block.fixtureId}\0${block.repetition}\0${right}`,
          ),
        ),
      )
      .map((arm) => ({
        cellId: benchmarkCellIdV3(spec, block.fixtureId, arm, block.repetition),
        fixtureId: block.fixtureId,
        arm,
        repetition: block.repetition,
      })),
  );
}

export function benchmarkAttemptHashV3(
  input: Omit<BenchmarkCellAttemptV3, "attemptHash">,
): string {
  return digest(input);
}

export function benchmarkAttemptIdV3(
  executionId: BenchmarkExecutionId,
  cellId: BenchmarkCellId,
  ordinal: number,
): BenchmarkAttemptId {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 6) {
    throw new Error("Benchmark V3 attempt ordinal exceeds the absolute budget");
  }
  return asBenchmarkAttemptId(
    `benchmark-attempt:${digest({ executionId, cellId, ordinal })}`,
  );
}

export function benchmarkExecutionSelectionHashV3(
  definitionId: BenchmarkSuiteSpecV3["definitionId"],
  executionId: BenchmarkExecutionId,
): string {
  return digest({
    policy: "first-formal-execution-wins-v2",
    definitionId,
    executionId,
  });
}

export interface ScoreBenchmarkDiagnosisV3Input {
  readonly proposalId: ProposalId | null;
  readonly candidateExecutionIds: readonly ExecutionId[];
  readonly accessReceiptIds: readonly EvidenceAccessReceiptId[];
  readonly expectedMechanism: Exclude<MechanismCodeV2, "unknown">;
  readonly proposedMechanism: MechanismCodeV2;
  readonly verdict: "confirmed" | "inconclusive";
  readonly sourceLocationCorrect: boolean | null;
  readonly sourceGrounded: boolean;
  readonly confidence: number | null;
}

export function scoreBenchmarkDiagnosisV3(
  input: ScoreBenchmarkDiagnosisV3Input,
): BenchmarkCellScoreV3 {
  const mechanismCorrect = input.expectedMechanism === input.proposedMechanism;
  return BenchmarkCellScoreV3Schema.parse({
    proposalId: input.proposalId,
    candidateExecutionIds: [...input.candidateExecutionIds],
    accessReceiptIds: [...input.accessReceiptIds],
    proposedMechanism: input.proposedMechanism,
    mechanismCorrect,
    verdict: input.verdict,
    groundedSuccess: mechanismCorrect && input.verdict === "confirmed",
    incorrectConfirmation: !mechanismCorrect && input.verdict === "confirmed",
    sourceLocationCorrect: input.sourceLocationCorrect,
    sourceGrounded: input.sourceGrounded,
    confidence: input.confidence,
  });
}

export function diagnosticFailureScoreV3(
  expectedMechanism: Exclude<MechanismCodeV2, "unknown">,
): BenchmarkCellScoreV3 {
  return scoreBenchmarkDiagnosisV3({
    proposalId: null,
    candidateExecutionIds: [],
    accessReceiptIds: [],
    expectedMechanism,
    proposedMechanism: "unknown",
    verdict: "inconclusive",
    sourceLocationCorrect: null,
    sourceGrounded: false,
    confidence: null,
  });
}

export type BenchmarkAttemptBudgetViolationV3 =
  | "game_executions"
  | "tool_calls"
  | "tool_errors"
  | "non_progress_tool_results"
  | "wall_timeout";

export function benchmarkAttemptBudgetViolationsV3(
  suiteInput: BenchmarkSuiteSpecV3,
  attemptInput: BenchmarkCellAttemptV3,
): readonly BenchmarkAttemptBudgetViolationV3[] {
  const suite = assertBenchmarkSuiteSpecV3Integrity(suiteInput);
  const attempt = BenchmarkCellAttemptV3Schema.parse(attemptInput);
  const tools = attempt.progress.tools;
  if (tools.failed + tools.semanticRevision > tools.completed) {
    throw new Error("Benchmark V3 tool outcomes exceed completed tool results");
  }
  if (attempt.metrics.toolCalls !== tools.started) {
    throw new Error("Benchmark V3 tool metrics are not exact progress counts");
  }
  if (
    attempt.metrics.gameExecutions !==
    attempt.progress.game.baselineExecutions +
      attempt.progress.game.diagnosticExecutions
  ) {
    throw new Error("Benchmark V3 game metrics are not exact progress counts");
  }
  const nonProgress = tools.completed - tools.failed - tools.semanticRevision;
  const violations: BenchmarkAttemptBudgetViolationV3[] = [];
  if (attempt.metrics.gameExecutions > suite.budgets.maxGameExecutions) {
    violations.push("game_executions");
  }
  if (attempt.metrics.toolCalls > suite.budgets.maxToolCalls) {
    violations.push("tool_calls");
  }
  if (tools.failed > suite.budgets.maxToolErrors) {
    violations.push("tool_errors");
  }
  if (nonProgress > suite.budgets.maxConsecutiveNonProgressToolResults) {
    violations.push("non_progress_tool_results");
  }
  if (attempt.metrics.wallTimeMs > suite.budgets.timeoutMs) {
    violations.push("wall_timeout");
  }
  return violations;
}

/**
 * Enforces score eligibility without erasing truthful terminal observations.
 * A diagnostic/invalid attempt may record the first violating observation, but
 * a completed score can never be produced outside the frozen budgets.
 */
export function assertBenchmarkAttemptBudgetsV3(
  suiteInput: BenchmarkSuiteSpecV3,
  attemptInput: BenchmarkCellAttemptV3,
): readonly BenchmarkAttemptBudgetViolationV3[] {
  const suite = assertBenchmarkSuiteSpecV3Integrity(suiteInput);
  const attempt = BenchmarkCellAttemptV3Schema.parse(attemptInput);
  const violations = benchmarkAttemptBudgetViolationsV3(suite, attempt);
  if (
    attempt.progress.game.baselineExecutions > suite.budgets.baselineExecutions
  ) {
    throw new Error("Benchmark V3 exceeded its baseline execution budget");
  }
  if (attempt.outcome.status === "completed") {
    if (violations.length > 0) {
      throw new Error("Benchmark V3 scored attempt exceeded frozen budgets");
    }
    if (
      attempt.progress.fixtureStage !== "fixture_validated" ||
      !attempt.progress.model.turnCompleted ||
      !attempt.progress.proposalSubmitted ||
      attempt.progress.tools.started !== attempt.progress.tools.completed
    ) {
      throw new Error("Benchmark V3 scored attempt is not terminally complete");
    }
  } else if (attempt.outcome.status === "diagnostic_failure") {
    const allowedBudgetTerminal =
      attempt.outcome.code === "budget_exhausted" ||
      attempt.outcome.code === "invalid_tool_flow" ||
      attempt.outcome.code === "progress_timeout";
    const expectedInvalidProposalToolFailure =
      attempt.outcome.code === "invalid_proposal" &&
      violations.length === 1 &&
      violations[0] === "tool_errors" &&
      attempt.progress.tools.failed === 1;
    if (
      violations.length > 0 &&
      !allowedBudgetTerminal &&
      !expectedInvalidProposalToolFailure
    ) {
      throw new Error(
        "Benchmark V3 budget violation contradicts diagnostic terminal code",
      );
    }
    if (
      violations.includes("wall_timeout") &&
      attempt.outcome.code !== "progress_timeout" &&
      attempt.outcome.code !== "budget_exhausted"
    ) {
      throw new Error(
        "Benchmark V3 wall timeout contradicts diagnostic terminal code",
      );
    }
  } else if (
    attempt.outcome.status === "infra_failure" &&
    violations.some((violation) => violation !== "wall_timeout")
  ) {
    throw new Error(
      "Benchmark V3 infrastructure attempt exceeded a diagnostic budget",
    );
  } else if (
    attempt.outcome.status === "infra_failure" &&
    violations.includes("wall_timeout") &&
    attempt.outcome.failure.kind !== "harness_timeout"
  ) {
    throw new Error(
      "Benchmark V3 provider failure cannot conceal a Harness wall timeout",
    );
  } else if (
    attempt.outcome.status === "interrupted" &&
    violations.length > 0
  ) {
    throw new Error("Benchmark V3 interrupted attempt exceeded frozen budgets");
  }
  return violations;
}

const sameJson = (left: unknown, right: unknown): boolean =>
  canonicalStringify(left as JsonValue) ===
  canonicalStringify(right as JsonValue);

const receiptIdForV3 = (receipt: EvidenceAccessReceiptV1): string =>
  `receipt:v1:${digest({
    runId: receipt.runId,
    fixtureId: receipt.fixtureId,
    accessKind: receipt.accessKind,
    resourceId: receipt.resourceId,
    requestHash: receipt.requestHash,
    contentHash: receipt.contentHash,
    sourceCoverage: [...receipt.sourceCoverage],
  } as unknown as JsonValue)}`;

const exactIds = (
  actual: readonly string[],
  expected: readonly string[],
): boolean =>
  actual.length === expected.length &&
  actual.every((value, index) => value === expected[index]);

export function unresolvedBenchmarkProposalEventIdsV3(
  evidence: BenchmarkCaseEvidenceV2,
  evidenceEventIds: readonly EventId[],
): readonly EventId[] {
  const availableEventIds = new Set([
    ...evidence.capsule.causalEvents.map((event) => event.eventId),
    ...(evidence.replay?.causalEvents.map((event) => event.eventId) ?? []),
    ...evidence.candidates.flatMap((candidate) =>
      candidate.causalEvents.map((event) => event.eventId),
    ),
  ]);
  return evidenceEventIds.filter((eventId) => !availableEventIds.has(eventId));
}

const assertManifestIdentityV3 = (
  suite: BenchmarkSuiteSpecV3,
  attempt: BenchmarkCellAttemptV3,
  manifest: BenchmarkRawAttemptManifestV3,
): BenchmarkFixtureSpecV3 => {
  if (
    manifest.suiteId !== suite.suiteId ||
    manifest.definitionId !== suite.definitionId ||
    manifest.executionId !== attempt.executionId ||
    manifest.cellId !== attempt.cellId ||
    manifest.attemptId !== attempt.attemptId ||
    manifest.fixtureId !== attempt.fixtureId ||
    manifest.arm !== attempt.arm ||
    manifest.repetition !== attempt.repetition ||
    manifest.ordinal !== attempt.ordinal
  ) {
    throw new Error("Benchmark V3 raw manifest lineage is invalid");
  }
  if (
    !sameJson(manifest.progress, attempt.progress) ||
    !sameJson(manifest.metrics, attempt.metrics)
  ) {
    throw new Error("Benchmark V3 raw manifest terminal facts are not exact");
  }
  const fixture = suite.fixtures.find(
    (candidate) => candidate.fixtureId === attempt.fixtureId,
  );
  if (
    fixture === undefined ||
    manifest.promptAudit.contractHash !== fixture.contractHash ||
    manifest.promptAudit.inputTraceHash !== fixture.inputTraceHash ||
    manifest.promptAudit.sourceViewHash !== fixture.aliasMapHash ||
    manifest.promptAudit.experimentCatalogHash !==
      fixture.interventionCatalogHash ||
    manifest.oracle.oracleHash !== fixture.oracleHash ||
    manifest.oracle.expectedMechanism !== fixture.expectedMechanism ||
    !sameJson(manifest.oracle.expectedSource, fixture.expectedSource) ||
    manifest.promptAudit.oracleHash !== fixture.oracleHash
  ) {
    throw new Error(
      "Benchmark V3 raw manifest frozen Fixture material binding is invalid",
    );
  }
  const evidence = manifest.caseEvidence;
  if (
    manifest.promptAudit.contractId !== evidence.contract.contractId ||
    manifest.promptAudit.contractHash !== evidence.contract.contentHash ||
    manifest.promptAudit.checkpointId !== evidence.checkpoint.checkpointId ||
    manifest.promptAudit.checkpointHash !== evidence.checkpoint.contentHash ||
    manifest.promptAudit.inputTraceId !== evidence.inputTrace.inputTraceId ||
    manifest.promptAudit.inputTraceHash !== evidence.inputTrace.contentHash ||
    manifest.promptAudit.baselineTimelineDigest !==
      evidence.baseline.timelineDigest ||
    manifest.promptAudit.runtimeFingerprintHash !==
      evidence.baseline.runtimeFingerprintHash
  ) {
    throw new Error("Benchmark V3 prompt audit contradicts case evidence");
  }
  return fixture;
};

const assertCanonicalReceiptsV3 = (
  manifest: Extract<
    BenchmarkRawAttemptManifestV3,
    { readonly terminalStatus: "completed" }
  >,
): ReadonlyMap<string, EvidenceAccessReceiptV1> => {
  if (
    !sameJson(manifest.accessReceipts, manifest.caseEvidence.accessReceipts)
  ) {
    throw new Error("Benchmark V3 receipt projections are not exact");
  }
  const receipts = new Map<string, EvidenceAccessReceiptV1>();
  for (const receipt of manifest.accessReceipts) {
    if (
      receipt.receiptId !== receiptIdForV3(receipt) ||
      receipt.runId !== manifest.runId ||
      receipt.fixtureId !== manifest.fixtureId ||
      receipts.has(receipt.receiptId)
    ) {
      throw new Error("Benchmark V3 evidence receipt is not canonical");
    }
    receipts.set(receipt.receiptId, receipt);
  }
  for (const receiptId of manifest.proposal.accessReceiptIds) {
    if (!receipts.has(receiptId)) {
      throw new Error("Benchmark V3 proposal cites an unresolved receipt");
    }
  }
  return receipts;
};

const assertFailureBriefReceiptBindingV3 = (
  manifest: BenchmarkRawAttemptManifestV3,
): void => {
  const receipt = manifest.caseEvidence.accessReceipts.find(
    (candidate) =>
      candidate.receiptId === manifest.promptAudit.failureBriefReceiptId,
  );
  if (
    receipt === undefined ||
    receipt.receiptId !== receiptIdForV3(receipt) ||
    receipt.runId !== manifest.runId ||
    receipt.fixtureId !== manifest.fixtureId ||
    receipt.accessKind !== "failure_brief" ||
    receipt.resourceId !== manifest.caseEvidence.capsule.capsuleId ||
    receipt.contentHash !== manifest.promptAudit.failureBriefHash ||
    (manifest.terminalStatus === "completed" &&
      !manifest.proposal.accessReceiptIds.includes(receipt.receiptId))
  ) {
    throw new Error("Benchmark V3 Failure Brief receipt binding is invalid");
  }
};

const assertEvidenceAccessBudgetsV3 = (
  suite: BenchmarkSuiteSpecV3,
  receipts: readonly EvidenceAccessReceiptV1[],
): void => {
  const replayCalls = receipts.filter(
    (receipt) => receipt.accessKind === "replay",
  ).length;
  const interventionCalls = receipts.filter(
    (receipt) =>
      receipt.accessKind === "experiment" &&
      receipt.resourceId !== "experiment-catalog",
  ).length;
  const sourceCalls = receipts.filter(
    (receipt) =>
      receipt.accessKind === "source_read" ||
      receipt.accessKind === "source_search",
  ).length;
  if (replayCalls > suite.budgets.maxReplays) {
    throw new Error("Benchmark V3 exceeded its replay budget");
  }
  if (interventionCalls > suite.budgets.maxInterventions) {
    throw new Error("Benchmark V3 exceeded its intervention budget");
  }
  if (sourceCalls > suite.budgets.maxSourceCalls) {
    throw new Error("Benchmark V3 exceeded its source-call budget");
  }
};

const assertCompletedManifestReferencesV3 = (
  manifest: Extract<
    BenchmarkRawAttemptManifestV3,
    { readonly terminalStatus: "completed" }
  >,
  receipts: ReadonlyMap<string, EvidenceAccessReceiptV1>,
): void => {
  const proposal = manifest.proposal;
  const evidence = manifest.caseEvidence;
  if (
    proposal.runId !== manifest.runId ||
    proposal.fixtureId !== manifest.fixtureId ||
    proposal.capsuleId !== evidence.capsule.capsuleId ||
    proposal.baselineExecutionId !== evidence.baseline.executionId ||
    proposal.replayExecutionId !== evidence.replay?.executionId
  ) {
    throw new Error("Benchmark V3 proposal investigation binding is invalid");
  }
  if (
    !exactIds(
      proposal.candidateExecutionIds,
      evidence.candidates.map((candidate) => candidate.executionId),
    ) ||
    !exactIds(
      proposal.comparisonIds,
      evidence.comparisons.map((comparison) => comparison.comparisonId),
    )
  ) {
    throw new Error(
      "Benchmark V3 proposal experiment references are not exact",
    );
  }
  const candidateIds = new Set(
    evidence.candidates.map((candidate) => candidate.executionId),
  );
  for (const comparison of evidence.comparisons) {
    if (
      comparison.baselineExecutionId !== evidence.baseline.executionId ||
      !candidateIds.has(comparison.candidateExecutionId)
    ) {
      throw new Error("Benchmark V3 comparison references are invalid");
    }
  }
  if (
    unresolvedBenchmarkProposalEventIdsV3(evidence, proposal.evidenceEventIds)
      .length > 0
  ) {
    throw new Error("Benchmark V3 proposal cites an unresolved event");
  }
  const citedReceipts = proposal.accessReceiptIds.flatMap((receiptId) => {
    const receipt = receipts.get(receiptId);
    return receipt === undefined ? [] : [receipt];
  });
  const covers = (kind: EvidenceAccessReceiptV1["accessKind"], id: string) =>
    citedReceipts.some(
      (receipt) => receipt.accessKind === kind && receipt.resourceId === id,
    );
  if (!covers("failure_brief", proposal.capsuleId)) {
    throw new Error("Benchmark V3 Failure Brief receipt is missing");
  }
  if (
    proposal.replayExecutionId !== undefined &&
    !covers("replay", proposal.replayExecutionId)
  ) {
    throw new Error("Benchmark V3 replay receipt is missing");
  }
  for (const candidateId of proposal.candidateExecutionIds) {
    if (!covers("experiment", candidateId)) {
      throw new Error("Benchmark V3 candidate receipt is missing");
    }
  }
  for (const comparisonId of proposal.comparisonIds) {
    if (!covers("comparison", comparisonId)) {
      throw new Error("Benchmark V3 comparison receipt is missing");
    }
  }
  if (
    proposal.evidenceEventIds.some((eventId) =>
      evidence.capsule.causalEvents.some((event) => event.eventId === eventId),
    ) &&
    !covers("raw_execution", proposal.baselineExecutionId) &&
    !covers("capsule", proposal.capsuleId)
  ) {
    throw new Error("Benchmark V3 cited Capsule events lack receipt coverage");
  }
};

const publicEventDescendsFromV3 = (
  event: BenchmarkPublicCausalEventV2,
  ancestorId: string,
  events: readonly BenchmarkPublicCausalEventV2[],
): boolean => {
  const byId = new Map(
    events.map((candidate) => [candidate.eventId, candidate]),
  );
  let current: BenchmarkPublicCausalEventV2 | undefined = event;
  const seen = new Set<string>();
  while (current?.causedByEventId !== null && current !== undefined) {
    if (current.causedByEventId === ancestorId) return true;
    if (seen.has(current.causedByEventId)) return false;
    seen.add(current.causedByEventId);
    current = byId.get(current.causedByEventId);
  }
  return false;
};

interface BenchmarkMechanismProposalFactsV3 {
  readonly mechanismCode: MechanismCodeV2;
  readonly evidenceEventIds: readonly string[];
}

/** Re-evaluates all four typed mechanism proofs from sanitized causal facts. */
export function validateBenchmarkMechanismProofV3(
  evidence: BenchmarkCaseEvidenceV2,
  proposal: BenchmarkMechanismProposalFactsV3,
): boolean {
  if (proposal.mechanismCode === "unknown") return false;
  const cited = new Set(proposal.evidenceEventIds);
  const cites = (...events: readonly BenchmarkPublicCausalEventV2[]): boolean =>
    events.every((event) => cited.has(event.eventId));
  const baselineEvents = evidence.capsule.causalEvents;
  const passingCandidates = evidence.candidates.filter(
    (candidate) => candidate.evaluationStatus === "pass",
  );
  const expected = evidence.capsule.expected;
  if (proposal.mechanismCode === "signal_before_receiver_connection") {
    const failed = baselineEvents.find(
      (event) =>
        event.kind === "signal_delivery" &&
        !event.delivered &&
        event.failureReason === "receiver_not_connected",
    );
    const connected = baselineEvents.find(
      (event) =>
        event.kind === "property_changed" &&
        event.path.endsWith("receiver_connected") &&
        event.after === true,
    );
    const baselineInput = baselineEvents.find(
      (event) => event.kind === "input",
    );
    if (
      failed === undefined ||
      connected === undefined ||
      failed.seq >= connected.seq ||
      baselineInput?.kind !== "input"
    ) {
      return false;
    }
    return passingCandidates.some((candidate) => {
      const input = candidate.causalEvents.find(
        (event) =>
          event.kind === "input" && event.action === baselineInput.action,
      );
      const delivered = candidate.causalEvents.find(
        (event) => event.kind === "signal_delivery" && event.delivered,
      );
      const changed = candidate.causalEvents.find(
        (event) =>
          event.kind === "property_changed" &&
          event.path === expected.path &&
          sameJson(event.after, expected.value),
      );
      return (
        input?.kind === "input" &&
        delivered?.kind === "signal_delivery" &&
        changed?.kind === "property_changed" &&
        input.realizedTick > baselineInput.realizedTick &&
        cites(failed, connected, delivered, changed) &&
        publicEventDescendsFromV3(
          changed,
          delivered.eventId,
          candidate.causalEvents,
        )
      );
    });
  }
  if (proposal.mechanismCode === "frame_count_used_for_time_window") {
    const opened = baselineEvents.find(
      (event) =>
        event.kind === "property_changed" &&
        event.path === "player.window_open" &&
        event.before === false &&
        event.after === true,
    );
    const closed = baselineEvents.find(
      (event) =>
        event.kind === "property_changed" &&
        event.path === "player.window_open" &&
        event.before === true &&
        event.after === false &&
        opened !== undefined &&
        event.seq > opened.seq,
    );
    const rejected = baselineEvents.find(
      (event) =>
        event.kind === "input" &&
        event.action === "attempt_jump" &&
        closed !== undefined &&
        event.seq > closed.seq,
    );
    const processFramesMatch = (
      execution: BenchmarkCaseEvidenceV2["baseline"],
    ): boolean => {
      const callbacks = execution.finalState.values["player.process_callbacks"];
      const realized = execution.stepReceipts.reduce(
        (total, receipt) => total + (receipt.runtime?.idleFramesExecuted ?? 0),
        0,
      );
      return (
        typeof callbacks === "number" &&
        Number.isInteger(callbacks) &&
        callbacks === realized &&
        execution.stepReceipts.every(
          (receipt) => receipt.runtime?.idleFramesExecuted === 1,
        )
      );
    };
    if (
      opened === undefined ||
      closed === undefined ||
      rejected === undefined ||
      !processFramesMatch(evidence.baseline)
    ) {
      return false;
    }
    return passingCandidates.some((candidate) => {
      const baselineFps =
        evidence.baseline.controlReceipt.realized["fixed_fps"];
      const candidateFps = candidate.controlReceipt.realized["fixed_fps"];
      const candidateOpened = candidate.causalEvents.find(
        (event) =>
          event.kind === "property_changed" &&
          event.path === "player.window_open" &&
          event.after === true,
      );
      const input = candidate.causalEvents.find(
        (event) => event.kind === "input" && event.action === "attempt_jump",
      );
      const jumped = candidate.causalEvents.find(
        (event) =>
          event.kind === "property_changed" &&
          event.path === expected.path &&
          sameJson(event.after, expected.value),
      );
      return (
        typeof baselineFps === "number" &&
        typeof candidateFps === "number" &&
        baselineFps !== candidateFps &&
        processFramesMatch(candidate) &&
        candidateOpened !== undefined &&
        input?.kind === "input" &&
        jumped?.kind === "property_changed" &&
        candidateOpened.seq < input.seq &&
        cites(opened, closed, rejected, candidateOpened, input, jumped) &&
        publicEventDescendsFromV3(jumped, input.eventId, candidate.causalEvents)
      );
    });
  }
  if (proposal.mechanismCode === "discrete_physics_tunneling") {
    const fired = baselineEvents.find(
      (event) => event.kind === "signal" && event.name === "projectile.fired",
    );
    if (fired?.kind !== "signal") return false;
    return passingCandidates.some((candidate) => {
      const baselineRate =
        evidence.baseline.controlReceipt.realized["physics_ticks_per_second"];
      const candidateRate =
        candidate.controlReceipt.realized["physics_ticks_per_second"];
      const candidateFire = candidate.causalEvents.find(
        (event) => event.kind === "signal" && event.name === "projectile.fired",
      );
      const hit = candidate.causalEvents.find(
        (event) =>
          event.kind === "property_changed" &&
          event.path === expected.path &&
          sameJson(event.after, expected.value),
      );
      const sample =
        hit === undefined
          ? undefined
          : candidate.causalEvents.find(
              (event) =>
                event.kind === "spatial_sample" &&
                publicEventDescendsFromV3(
                  hit,
                  event.eventId,
                  candidate.causalEvents,
                ),
            );
      if (
        typeof baselineRate !== "number" ||
        typeof candidateRate !== "number" ||
        baselineRate === candidateRate ||
        candidateFire?.kind !== "signal" ||
        hit?.kind !== "property_changed" ||
        sample?.kind !== "spatial_sample"
      ) {
        return false;
      }
      const targetX = sample.position[0];
      const crossed = baselineEvents.find(
        (event) =>
          event.kind === "property_changed" &&
          event.path === "projectile.x" &&
          typeof event.before === "number" &&
          typeof event.after === "number" &&
          ((event.before < targetX && event.after > targetX) ||
            (event.before > targetX && event.after < targetX)),
      );
      const crossedSample =
        crossed?.kind === "property_changed"
          ? baselineEvents.find(
              (event) =>
                event.kind === "spatial_sample" &&
                event.causedByEventId === crossed.eventId &&
                event.position[0] === crossed.after,
            )
          : undefined;
      return (
        crossed?.kind === "property_changed" &&
        crossedSample?.kind === "spatial_sample" &&
        cites(fired, crossed, crossedSample, candidateFire, hit, sample) &&
        publicEventDescendsFromV3(crossed, fired.eventId, baselineEvents) &&
        publicEventDescendsFromV3(
          hit,
          candidateFire.eventId,
          candidate.causalEvents,
        )
      );
    });
  }
  const scheduled = baselineEvents.find(
    (event) => event.kind === "pending_effect" && event.action === "scheduled",
  );
  const despawned = baselineEvents.find(
    (event) =>
      event.kind === "entity_lifecycle" &&
      event.action === "despawned" &&
      scheduled?.kind === "pending_effect" &&
      event.entity.stableId === scheduled.target.stableId &&
      event.entity.incarnation === scheduled.target.incarnation &&
      publicEventDescendsFromV3(event, scheduled.eventId, baselineEvents),
  );
  const spawned = baselineEvents.find(
    (event) =>
      event.kind === "entity_lifecycle" &&
      event.action === "spawned" &&
      despawned?.kind === "entity_lifecycle" &&
      event.entity.stableId === despawned.entity.stableId &&
      event.entity.incarnation !== despawned.entity.incarnation &&
      publicEventDescendsFromV3(event, despawned.eventId, baselineEvents),
  );
  const applied = baselineEvents.find(
    (event) =>
      event.kind === "pending_effect" &&
      event.action === "applied" &&
      scheduled?.kind === "pending_effect" &&
      spawned?.kind === "entity_lifecycle" &&
      event.effectId === scheduled.effectId &&
      event.target.stableId === scheduled.target.stableId &&
      event.target.incarnation === scheduled.target.incarnation &&
      event.resolvedTarget?.stableId === spawned.entity.stableId &&
      event.resolvedTarget.incarnation === spawned.entity.incarnation &&
      publicEventDescendsFromV3(event, spawned.eventId, baselineEvents),
  );
  const mutation = baselineEvents.find(
    (event) =>
      event.kind === "property_changed" &&
      event.path === "enemy.health" &&
      !sameJson(event.after, expected.value) &&
      applied?.kind === "pending_effect" &&
      publicEventDescendsFromV3(event, applied.eventId, baselineEvents),
  );
  if (
    scheduled?.kind !== "pending_effect" ||
    despawned?.kind !== "entity_lifecycle" ||
    spawned?.kind !== "entity_lifecycle" ||
    applied?.kind !== "pending_effect" ||
    mutation?.kind !== "property_changed"
  ) {
    return false;
  }
  return passingCandidates.some((candidate) => {
    const pooling =
      candidate.controlReceipt.realized["fixture.pooling_enabled"];
    const discarded = candidate.causalEvents.find(
      (event) =>
        event.kind === "pending_effect" &&
        event.action === "discarded" &&
        event.effectId === scheduled.effectId &&
        event.target.stableId === scheduled.target.stableId &&
        event.target.incarnation === scheduled.target.incarnation &&
        event.reason === "owner_destroyed",
    );
    return (
      pooling === false &&
      discarded?.kind === "pending_effect" &&
      cites(scheduled, despawned, spawned, applied, mutation, discarded)
    );
  });
}

const assertCanonicalVerdictV3 = (
  manifest: Extract<
    BenchmarkRawAttemptManifestV3,
    { readonly terminalStatus: "completed" }
  >,
  receipts: ReadonlyMap<string, EvidenceAccessReceiptV1>,
): void => {
  const { proposal, verdict, caseEvidence: evidence } = manifest;
  const expectedStatus =
    verdict.blockers.length === 0 ? "confirmed" : "inconclusive";
  const expectedSummary =
    expectedStatus === "confirmed"
      ? `Harness evidence confirms ${proposal.mechanismCode}`
      : "Evidence is insufficient for a canonical diagnosis";
  if (
    verdict.proposalId !== proposal.proposalId ||
    verdict.runId !== proposal.runId ||
    verdict.fixtureId !== proposal.fixtureId ||
    verdict.mechanismCode !== proposal.mechanismCode ||
    verdict.status !== expectedStatus ||
    verdict.summary !== expectedSummary
  ) {
    throw new Error(
      "Benchmark V3 verdict is not the canonical Harness verdict",
    );
  }
  if (verdict.status !== "confirmed") return;
  const replay = evidence.replay;
  const passingCandidateIds = new Set(
    evidence.candidates
      .filter((candidate) => candidate.evaluationStatus === "pass")
      .map((candidate) => candidate.executionId),
  );
  const passingComparison = evidence.comparisons.some(
    (comparison) =>
      comparison.comparable &&
      comparison.baselineOutcome === "fail" &&
      comparison.candidateOutcome === "pass" &&
      passingCandidateIds.has(comparison.candidateExecutionId),
  );
  const genericComparisonPath =
    evidence.comparisons.length === 0 &&
    proposal.accessReceiptIds.some((receiptId) => {
      const receipt = receipts.get(receiptId);
      return (
        receipt?.accessKind === "raw_execution" &&
        receipt.resourceId === proposal.baselineExecutionId
      );
    });
  if (
    proposal.mechanismCode === "unknown" ||
    proposal.blockers.length > 0 ||
    proposal.evidenceEventIds.length === 0 ||
    !proposal.evidenceEventIds.some((eventId) =>
      evidence.capsule.causalEvents.some((event) => event.eventId === eventId),
    ) ||
    evidence.capsule.eventLossDetected ||
    evidence.baseline.evaluationStatus !== "fail" ||
    replay === null ||
    replay.evaluationStatus !== "fail" ||
    !replay.timelineMatchesBaseline ||
    passingCandidateIds.size === 0 ||
    (!passingComparison && !genericComparisonPath) ||
    !validateBenchmarkMechanismProofV3(evidence, proposal)
  ) {
    throw new Error("Benchmark V3 confirmed verdict lacks grounding evidence");
  }
};

const sourceAssessmentV3 = (
  fixture: BenchmarkFixtureSpecV3,
  manifest: Extract<
    BenchmarkRawAttemptManifestV3,
    { readonly terminalStatus: "completed" }
  >,
  receipts: ReadonlyMap<string, EvidenceAccessReceiptV1>,
): { readonly location: boolean | null; readonly grounded: boolean } => {
  const suspected = manifest.proposal.suspectedSource;
  if (suspected?.symbol === undefined) {
    return { location: null, grounded: false };
  }
  const grounded = manifest.proposal.accessReceiptIds.some((receiptId) => {
    const receipt = receipts.get(receiptId);
    return (
      (receipt?.accessKind === "source_read" ||
        receipt?.accessKind === "source_search") &&
      receipt.sourceCoverage.some(
        (coverage) =>
          coverage.virtualPath === suspected.path &&
          coverage.coveredSymbols.includes(suspected.symbol!),
      )
    );
  });
  return {
    grounded,
    location: grounded
      ? suspected.path === fixture.expectedSource.virtualPath &&
        suspected.symbol === fixture.expectedSource.symbol
      : null,
  };
};

export interface AssertBenchmarkRawAttemptManifestV3Input {
  readonly suite: BenchmarkSuiteSpecV3;
  readonly attempt: BenchmarkCellAttemptV3;
  readonly manifest: unknown;
}

export interface VerifiedBenchmarkRawAttemptManifestV3 {
  readonly manifest: BenchmarkRawAttemptManifestV3;
  readonly score: BenchmarkCellScoreV3;
}

/** Recomputes the only score admissible for a terminal raw attempt. */
export function assertBenchmarkRawAttemptManifestV3Integrity(
  input: AssertBenchmarkRawAttemptManifestV3Input,
): VerifiedBenchmarkRawAttemptManifestV3 {
  const suite = assertBenchmarkSuiteSpecV3Integrity(input.suite);
  const attempt = BenchmarkCellAttemptV3Schema.parse(input.attempt);
  const manifest = BenchmarkRawAttemptManifestV3Schema.parse(input.manifest);
  const fixture = assertManifestIdentityV3(suite, attempt, manifest);
  assertBenchmarkAttemptBudgetsV3(suite, attempt);
  assertFailureBriefReceiptBindingV3(manifest);
  assertEvidenceAccessBudgetsV3(suite, manifest.caseEvidence.accessReceipts);
  if (
    manifest.terminalStatus !== attempt.outcome.status ||
    (attempt.outcome.status !== "completed" &&
      attempt.outcome.status !== "diagnostic_failure")
  ) {
    throw new Error("Benchmark V3 raw manifest terminal status is invalid");
  }
  if (
    attempt.outcome.rawManifestHash !== digest(manifest as unknown as JsonValue)
  ) {
    throw new Error("Benchmark V3 raw manifest hash is invalid");
  }
  if (manifest.terminalStatus === "diagnostic_failure") {
    if (
      attempt.outcome.status !== "diagnostic_failure" ||
      manifest.diagnosticCode !== attempt.outcome.code
    ) {
      throw new Error("Benchmark V3 diagnostic classification is invalid");
    }
    return {
      manifest,
      score: diagnosticFailureScoreV3(fixture.expectedMechanism),
    };
  }
  const receipts = assertCanonicalReceiptsV3(manifest);
  assertCompletedManifestReferencesV3(manifest, receipts);
  assertCanonicalVerdictV3(manifest, receipts);
  const source = sourceAssessmentV3(fixture, manifest, receipts);
  return {
    manifest,
    score: scoreBenchmarkDiagnosisV3({
      proposalId: manifest.proposal.proposalId,
      candidateExecutionIds: manifest.proposal.candidateExecutionIds,
      accessReceiptIds: manifest.proposal.accessReceiptIds,
      expectedMechanism: fixture.expectedMechanism,
      proposedMechanism: manifest.proposal.mechanismCode,
      verdict: manifest.verdict.status,
      sourceLocationCorrect: source.location,
      sourceGrounded: source.grounded,
      confidence: manifest.proposal.confidence,
    }),
  };
}

export function benchmarkCellScoringProofFromRawManifestV3(
  manifestInput: BenchmarkRawAttemptManifestV3,
): BenchmarkCellScoringProofV3 {
  const manifest = BenchmarkRawAttemptManifestV3Schema.parse(manifestInput);
  const common = {
    schemaVersion: 3 as const,
    cellId: manifest.cellId,
    selectedAttemptId: manifest.attemptId,
    rawManifestHash: digest(manifest as unknown as JsonValue),
    oracle: manifest.oracle,
  };
  if (manifest.terminalStatus === "diagnostic_failure") {
    return BenchmarkCellScoringProofV3Schema.parse({
      ...common,
      proofKind: "diagnostic_failure",
      diagnosticCode: manifest.diagnosticCode,
    });
  }
  return BenchmarkCellScoringProofV3Schema.parse({
    ...common,
    proofKind: "scored",
    caseEvidence: manifest.caseEvidence,
    proposal: {
      proposalId: manifest.proposal.proposalId,
      runId: manifest.proposal.runId,
      fixtureId: manifest.proposal.fixtureId,
      capsuleId: manifest.proposal.capsuleId,
      baselineExecutionId: manifest.proposal.baselineExecutionId,
      replayExecutionId: manifest.proposal.replayExecutionId ?? null,
      candidateExecutionIds: manifest.proposal.candidateExecutionIds,
      comparisonIds: manifest.proposal.comparisonIds,
      accessReceiptIds: manifest.proposal.accessReceiptIds,
      mechanismCode: manifest.proposal.mechanismCode,
      evidenceEventIds: manifest.proposal.evidenceEventIds,
      suspectedSource:
        manifest.proposal.suspectedSource === undefined
          ? null
          : {
              path: manifest.proposal.suspectedSource.path,
              symbol: manifest.proposal.suspectedSource.symbol ?? null,
            },
      hasBlockers: manifest.proposal.blockers.length > 0,
      confidence: manifest.proposal.confidence,
    },
    accessReceipts: manifest.accessReceipts,
    verdict: {
      verdictId: manifest.verdict.verdictId,
      proposalId: manifest.verdict.proposalId,
      runId: manifest.verdict.runId,
      fixtureId: manifest.verdict.fixtureId,
      status: manifest.verdict.status,
      mechanismCode: manifest.verdict.mechanismCode,
      blockerCount: manifest.verdict.blockers.length,
    },
  });
}

export interface AssertBenchmarkCellScoringProofV3Input {
  readonly suite: BenchmarkSuiteSpecV3;
  readonly attempt: BenchmarkCellAttemptV3;
  readonly cell: BenchmarkCellResultV3;
  readonly proof: unknown;
}

export function assertBenchmarkCellScoringProofV3Integrity(
  input: AssertBenchmarkCellScoringProofV3Input,
): BenchmarkCellScoreV3 {
  const suite = assertBenchmarkSuiteSpecV3Integrity(input.suite);
  const attempt = BenchmarkCellAttemptV3Schema.parse(input.attempt);
  const cell = BenchmarkCellResultV3Schema.parse(input.cell);
  const proof = BenchmarkCellScoringProofV3Schema.parse(input.proof);
  const fixture = suite.fixtures.find(
    (candidate) => candidate.fixtureId === cell.fixtureId,
  );
  if (
    fixture === undefined ||
    proof.cellId !== cell.cellId ||
    proof.selectedAttemptId !== cell.selectedAttemptId ||
    proof.selectedAttemptId !== attempt.attemptId ||
    proof.rawManifestHash !== cell.rawManifestHash ||
    proof.oracle.oracleHash !== fixture.oracleHash ||
    proof.oracle.expectedMechanism !== fixture.expectedMechanism ||
    !sameJson(proof.oracle.expectedSource, fixture.expectedSource)
  ) {
    throw new Error("Benchmark V3 scoring proof binding is invalid");
  }
  if (proof.proofKind === "diagnostic_failure") {
    if (
      cell.status !== "diagnostic_failure" ||
      attempt.outcome.status !== "diagnostic_failure" ||
      proof.diagnosticCode !== attempt.outcome.code ||
      proof.diagnosticCode !== cell.terminalCode
    ) {
      throw new Error("Benchmark V3 diagnostic scoring proof is invalid");
    }
    return diagnosticFailureScoreV3(fixture.expectedMechanism);
  }
  if (cell.status !== "scored" || attempt.outcome.status !== "completed") {
    throw new Error("Benchmark V3 scored proof contradicts terminal status");
  }
  const { proposal, verdict, caseEvidence: evidence } = proof;
  if (!sameJson(proof.accessReceipts, evidence.accessReceipts)) {
    throw new Error("Benchmark V3 scoring proof receipts are not exact");
  }
  const receipts = new Map<string, EvidenceAccessReceiptV1>();
  for (const receipt of proof.accessReceipts) {
    if (
      receipt.receiptId !== receiptIdForV3(receipt) ||
      receipt.runId !== proposal.runId ||
      receipt.fixtureId !== proposal.fixtureId ||
      receipts.has(receipt.receiptId)
    ) {
      throw new Error("Benchmark V3 scoring proof receipt is not canonical");
    }
    receipts.set(receipt.receiptId, receipt);
  }
  assertEvidenceAccessBudgetsV3(suite, proof.accessReceipts);
  if (
    proposal.fixtureId !== fixture.fixtureId ||
    proposal.capsuleId !== evidence.capsule.capsuleId ||
    proposal.baselineExecutionId !== evidence.baseline.executionId ||
    (proposal.replayExecutionId !== evidence.replay?.executionId &&
      !(proposal.replayExecutionId === null && evidence.replay === null)) ||
    !exactIds(
      proposal.candidateExecutionIds,
      evidence.candidates.map((candidate) => candidate.executionId),
    ) ||
    !exactIds(
      proposal.comparisonIds,
      evidence.comparisons.map((comparison) => comparison.comparisonId),
    ) ||
    proposal.accessReceiptIds.some((receiptId) => !receipts.has(receiptId))
  ) {
    throw new Error("Benchmark V3 scoring proof references are invalid");
  }
  const candidateIds = new Set(
    evidence.candidates.map((candidate) => candidate.executionId),
  );
  if (
    evidence.comparisons.some(
      (comparison) =>
        comparison.baselineExecutionId !== evidence.baseline.executionId ||
        !candidateIds.has(comparison.candidateExecutionId),
    )
  ) {
    throw new Error("Benchmark V3 scoring proof comparison is unresolved");
  }
  if (
    unresolvedBenchmarkProposalEventIdsV3(evidence, proposal.evidenceEventIds)
      .length > 0
  ) {
    throw new Error("Benchmark V3 scoring proof event is unresolved");
  }
  const citedReceipts = proposal.accessReceiptIds.map((receiptId) =>
    receipts.get(receiptId)!,
  );
  const covers = (kind: EvidenceAccessReceiptV1["accessKind"], id: string) =>
    citedReceipts.some(
      (receipt) => receipt.accessKind === kind && receipt.resourceId === id,
    );
  if (!covers("failure_brief", proposal.capsuleId)) {
    throw new Error(
      "Benchmark V3 scoring proof lacks the Failure Brief receipt",
    );
  }
  if (
    proposal.replayExecutionId !== null &&
    !covers("replay", proposal.replayExecutionId)
  ) {
    throw new Error("Benchmark V3 scoring proof lacks its replay receipt");
  }
  if (
    proposal.candidateExecutionIds.some(
      (candidateId) => !covers("experiment", candidateId),
    ) ||
    proposal.comparisonIds.some(
      (comparisonId) => !covers("comparison", comparisonId),
    )
  ) {
    throw new Error("Benchmark V3 scoring proof lacks experiment receipts");
  }
  if (
    verdict.proposalId !== proposal.proposalId ||
    verdict.runId !== proposal.runId ||
    verdict.fixtureId !== proposal.fixtureId ||
    verdict.mechanismCode !== proposal.mechanismCode ||
    verdict.status !==
      (verdict.blockerCount === 0 ? "confirmed" : "inconclusive")
  ) {
    throw new Error("Benchmark V3 scoring proof verdict is invalid");
  }
  if (verdict.status === "confirmed") {
    const passingCandidates = evidence.candidates.filter(
      (candidate) => candidate.evaluationStatus === "pass",
    );
    const passingIds = new Set(
      passingCandidates.map((candidate) => candidate.executionId),
    );
    const comparablePass = evidence.comparisons.some(
      (comparison) =>
        comparison.comparable &&
        comparison.baselineOutcome === "fail" &&
        comparison.candidateOutcome === "pass" &&
        passingIds.has(comparison.candidateExecutionId),
    );
    const genericPath =
      evidence.comparisons.length === 0 &&
      covers("raw_execution", proposal.baselineExecutionId);
    if (
      proposal.mechanismCode === "unknown" ||
      proposal.hasBlockers ||
      proposal.evidenceEventIds.length === 0 ||
      !proposal.evidenceEventIds.some((eventId) =>
        evidence.capsule.causalEvents.some(
          (event) => event.eventId === eventId,
        ),
      ) ||
      evidence.capsule.eventLossDetected ||
      evidence.baseline.evaluationStatus !== "fail" ||
      evidence.replay?.evaluationStatus !== "fail" ||
      evidence.replay.timelineMatchesBaseline !== true ||
      passingCandidates.length === 0 ||
      (!comparablePass && !genericPath) ||
      !validateBenchmarkMechanismProofV3(evidence, proposal)
    ) {
      throw new Error(
        `Benchmark V3 scoring proof cannot confirm ${proposal.mechanismCode}`,
      );
    }
  }
  const suspected = proposal.suspectedSource;
  const grounded =
    suspected?.symbol !== null && suspected !== null
      ? proposal.accessReceiptIds.some((receiptId) => {
          const receipt = receipts.get(receiptId);
          return (
            (receipt?.accessKind === "source_read" ||
              receipt?.accessKind === "source_search") &&
            receipt.sourceCoverage.some(
              (coverage) =>
                coverage.virtualPath === suspected.path &&
                coverage.coveredSymbols.includes(suspected.symbol!),
            )
          );
        })
      : false;
  return scoreBenchmarkDiagnosisV3({
    proposalId: proposal.proposalId,
    candidateExecutionIds: proposal.candidateExecutionIds,
    accessReceiptIds: proposal.accessReceiptIds,
    expectedMechanism: fixture.expectedMechanism,
    proposedMechanism: proposal.mechanismCode,
    verdict: verdict.status,
    sourceLocationCorrect: grounded
      ? suspected?.path === fixture.expectedSource.virtualPath &&
        suspected.symbol === fixture.expectedSource.symbol
      : null,
    sourceGrounded: grounded,
    confidence: proposal.confidence,
  });
}

const fixtureStageRank: Readonly<
  Record<BenchmarkAttemptProgressStateV3["fixtureStage"], number>
> = {
  none: 0,
  baseline_captured: 1,
  fixture_validated: 2,
};

const assertNeverDecreases = (
  before: number,
  after: number,
  field: string,
): void => {
  if (after < before) {
    throw new Error(`Benchmark V3 progress ${field} decreased`);
  }
};

const assertProgressMonotonic = (
  before: BenchmarkAttemptProgressV3,
  after: BenchmarkAttemptProgressV3,
): void => {
  if (
    fixtureStageRank[after.progress.fixtureStage] <
    fixtureStageRank[before.progress.fixtureStage]
  ) {
    throw new Error("Benchmark V3 Fixture progress regressed");
  }
  for (const field of [
    "requestStarted",
    "outputObserved",
    "turnCompleted",
  ] as const) {
    if (before.progress.model[field] && !after.progress.model[field]) {
      throw new Error(`Benchmark V3 model progress ${field} regressed`);
    }
  }
  if (before.progress.proposalSubmitted && !after.progress.proposalSubmitted) {
    throw new Error("Benchmark V3 proposal progress regressed");
  }
  for (const field of [
    "started",
    "completed",
    "failed",
    "semanticRevision",
  ] as const) {
    assertNeverDecreases(
      before.progress.tools[field],
      after.progress.tools[field],
      `tools.${field}`,
    );
  }
  for (const field of ["baselineExecutions", "diagnosticExecutions"] as const) {
    assertNeverDecreases(
      before.progress.game[field],
      after.progress.game[field],
      `game.${field}`,
    );
  }
  for (const field of ["gameExecutions", "toolCalls", "wallTimeMs"] as const) {
    assertNeverDecreases(
      before.metrics[field],
      after.metrics[field],
      `metrics.${field}`,
    );
  }
  for (const field of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "total",
  ] as const) {
    assertNeverDecreases(
      before.metrics.tokens[field],
      after.metrics.tokens[field],
      `metrics.tokens.${field}`,
    );
  }
};

/** Validates one immutable attempt journal without interpreting baseline as Agent progress. */
export function assertBenchmarkAttemptProgressSequenceV3(
  input: readonly BenchmarkAttemptProgressV3[],
): readonly BenchmarkAttemptProgressV3[] {
  const snapshots = input.map((snapshot) =>
    BenchmarkAttemptProgressV3Schema.parse(snapshot),
  );
  const first = snapshots[0];
  if (first === undefined) return snapshots;
  for (const [index, snapshot] of snapshots.entries()) {
    if (
      snapshot.suiteId !== first.suiteId ||
      snapshot.definitionId !== first.definitionId ||
      snapshot.executionId !== first.executionId ||
      snapshot.cellId !== first.cellId ||
      snapshot.attemptId !== first.attemptId ||
      snapshot.ordinal !== first.ordinal
    ) {
      throw new Error("Benchmark V3 progress journal lineage changed");
    }
    if (snapshot.sequence !== index + 1) {
      throw new Error("Benchmark V3 progress sequences must be contiguous");
    }
    const previous = snapshots[index - 1];
    if (previous !== undefined) {
      if (Date.parse(snapshot.observedAt) < Date.parse(previous.observedAt)) {
        throw new Error("Benchmark V3 progress time regressed");
      }
      assertProgressMonotonic(previous, snapshot);
    }
  }
  return snapshots;
}

export interface BuildBenchmarkReportV3Options {
  readonly suite: BenchmarkSuiteSpecV3;
  readonly executionId: BenchmarkExecutionId;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly provenance: BenchmarkReportV3["provenance"];
  readonly attempts: readonly BenchmarkCellAttemptV3[];
  readonly cells: readonly BenchmarkCellResultV3[];
  readonly scoringProofs: readonly BenchmarkCellScoringProofV3[];
  readonly auditIssues?: readonly "prompt_fairness_failed"[] | undefined;
}

export type BenchmarkReportHashBasisV3 = Omit<BenchmarkReportV3, "reportHash">;

export function benchmarkReportHashV3(
  input: BenchmarkReportHashBasisV3,
): string {
  return digest(input as unknown as JsonValue);
}

interface ExpectedCellV3 {
  readonly fixtureId: FixtureId;
  readonly arm: BenchmarkArmV1;
  readonly repetition: number;
  readonly expectedMechanism: Exclude<MechanismCodeV2, "unknown">;
}

const expectedCells = (
  suite: BenchmarkSuiteSpecV3,
): ReadonlyMap<BenchmarkCellId, ExpectedCellV3> => {
  const cells = new Map<BenchmarkCellId, ExpectedCellV3>();
  for (const fixture of suite.fixtures) {
    for (let repetition = 1; repetition <= suite.repetitions; repetition += 1) {
      for (const arm of suite.arms) {
        cells.set(
          benchmarkCellIdV3(suite, fixture.fixtureId, arm, repetition),
          {
            fixtureId: fixture.fixtureId,
            arm,
            repetition,
            expectedMechanism: fixture.expectedMechanism,
          },
        );
      }
    }
  }
  return cells;
};

const assertEntryProvenance = (
  suite: BenchmarkSuiteSpecV3,
  executionId: BenchmarkExecutionId,
  entry: BenchmarkCellAttemptV3 | BenchmarkCellResultV3,
): void => {
  if (
    entry.suiteId !== suite.suiteId ||
    entry.definitionId !== suite.definitionId ||
    entry.executionId !== executionId
  ) {
    throw new Error("Benchmark V3 entry provenance does not match execution");
  }
};

const assertAttempts = (
  suite: BenchmarkSuiteSpecV3,
  executionId: BenchmarkExecutionId,
  attemptsInput: readonly BenchmarkCellAttemptV3[],
  expected: ReadonlyMap<BenchmarkCellId, ExpectedCellV3>,
): ReadonlyMap<BenchmarkCellId, readonly BenchmarkCellAttemptV3[]> => {
  const attemptsByCell = new Map<BenchmarkCellId, BenchmarkCellAttemptV3[]>();
  const attemptIds = new Set<string>();
  let previousFinishedAt: number | null = null;
  for (const input of attemptsInput) {
    const attempt = BenchmarkCellAttemptV3Schema.parse(input);
    const startedAt = Date.parse(attempt.startedAt);
    if (previousFinishedAt !== null && startedAt < previousFinishedAt) {
      throw new Error("Benchmark V3 attempts must be globally serial");
    }
    previousFinishedAt = Date.parse(attempt.finishedAt);
    assertEntryProvenance(suite, executionId, attempt);
    if (attemptIds.has(attempt.attemptId)) {
      throw new Error("Benchmark V3 attempt IDs must be unique");
    }
    attemptIds.add(attempt.attemptId);
    const canonical = expected.get(attempt.cellId);
    if (
      canonical === undefined ||
      canonical.fixtureId !== attempt.fixtureId ||
      canonical.arm !== attempt.arm ||
      canonical.repetition !== attempt.repetition
    ) {
      throw new Error("Benchmark V3 attempt does not match its cell");
    }
    if (
      attempt.attemptId !==
      benchmarkAttemptIdV3(executionId, attempt.cellId, attempt.ordinal)
    ) {
      throw new Error("Benchmark V3 attempt ID is not canonical");
    }
    const { attemptHash, ...basis } = attempt;
    void attemptHash;
    if (benchmarkAttemptHashV3(basis) !== attempt.attemptHash) {
      throw new Error("Benchmark V3 attempt hash is invalid");
    }
    assertBenchmarkAttemptBudgetsV3(suite, attempt);
    const chain = attemptsByCell.get(attempt.cellId) ?? [];
    chain.push(attempt);
    attemptsByCell.set(attempt.cellId, chain);
  }
  for (const chain of attemptsByCell.values()) {
    chain.sort((left, right) => left.ordinal - right.ordinal);
    if (chain.length > suite.retryPolicy.maxAttemptsPerCell) {
      throw new Error("Benchmark V3 cell exceeded its absolute attempt budget");
    }
    for (const [index, attempt] of chain.entries()) {
      if (attempt.ordinal !== index + 1) {
        throw new Error("Benchmark V3 attempt ordinals must be contiguous");
      }
      const previous = chain[index - 1];
      if ((previous?.attemptHash ?? null) !== attempt.previousAttemptHash) {
        throw new Error("Benchmark V3 attempt hash chain is broken");
      }
      if (
        previous !== undefined &&
        !(
          (previous.outcome.status === "infra_failure" &&
            previous.outcome.retryable) ||
          previous.outcome.status === "interrupted"
        )
      ) {
        throw new Error("Benchmark V3 attempt follows a terminal outcome");
      }
    }
  }
  const canonicalOrder = benchmarkCellOrderV3(suite);
  const canonicalIndex = new Map(
    canonicalOrder.map((cell, index) => [cell.cellId, index] as const),
  );
  const scheduleSorted = [...attemptsInput].sort((left, right) => {
    const leftPhase = left.ordinal <= 3 ? 0 : 1;
    const rightPhase = right.ordinal <= 3 ? 0 : 1;
    if (leftPhase !== rightPhase) return leftPhase - rightPhase;
    const cellDifference =
      (canonicalIndex.get(left.cellId) ?? Number.MAX_SAFE_INTEGER) -
      (canonicalIndex.get(right.cellId) ?? Number.MAX_SAFE_INTEGER);
    return cellDifference === 0 ? left.ordinal - right.ordinal : cellDifference;
  });
  if (
    scheduleSorted.some(
      (attempt, index) => attempt.attemptId !== attemptsInput[index]?.attemptId,
    )
  ) {
    throw new Error("Benchmark V3 attempts violate the frozen schedule");
  }
  const initialCellIds = attemptsInput
    .filter((attempt) => attempt.ordinal <= 3)
    .map((attempt) => attempt.cellId)
    .filter((cellId, index, values) => values.indexOf(cellId) === index);
  if (
    initialCellIds.some(
      (cellId, index) => cellId !== canonicalOrder[index]?.cellId,
    )
  ) {
    throw new Error("Benchmark V3 initial cells must be a canonical prefix");
  }
  if (
    attemptsInput.some((attempt) => attempt.ordinal >= 4) &&
    initialCellIds.length !== canonicalOrder.length
  ) {
    throw new Error(
      "Benchmark V3 recovery attempts require a complete initial schedule",
    );
  }
  return attemptsByCell;
};

const assertCells = (
  suite: BenchmarkSuiteSpecV3,
  executionId: BenchmarkExecutionId,
  cellsInput: readonly BenchmarkCellResultV3[],
  expected: ReadonlyMap<BenchmarkCellId, ExpectedCellV3>,
  attemptsByCell: ReadonlyMap<
    BenchmarkCellId,
    readonly BenchmarkCellAttemptV3[]
  >,
): readonly BenchmarkCellResultV3[] => {
  const cells = cellsInput.map((cell) =>
    BenchmarkCellResultV3Schema.parse(cell),
  );
  const actualIds = cells.map((cell) => cell.cellId);
  const included = new Set(actualIds);
  const canonicalIds = benchmarkCellOrderV3(suite)
    .map((cell) => cell.cellId)
    .filter((cellId) => included.has(cellId));
  if (canonicalIds.some((cellId, index) => cellId !== actualIds[index])) {
    throw new Error("Benchmark V3 cells violate the frozen schedule");
  }
  const seen = new Set<string>();
  for (const cell of cells) {
    assertEntryProvenance(suite, executionId, cell);
    if (seen.has(cell.cellId)) {
      throw new Error("Benchmark V3 cell IDs must be unique");
    }
    seen.add(cell.cellId);
    const canonical = expected.get(cell.cellId);
    if (
      canonical === undefined ||
      canonical.fixtureId !== cell.fixtureId ||
      canonical.arm !== cell.arm ||
      canonical.repetition !== cell.repetition ||
      canonical.expectedMechanism !== cell.expectedMechanism
    ) {
      throw new Error("Benchmark V3 result does not match its canonical cell");
    }
    const chain = attemptsByCell.get(cell.cellId) ?? [];
    if (
      chain.length !== cell.attemptIds.length ||
      chain.some(
        (attempt, index) => attempt.attemptId !== cell.attemptIds[index],
      ) ||
      chain.at(-1)?.attemptId !== cell.selectedAttemptId
    ) {
      throw new Error(
        "Benchmark V3 cell does not cite its exact attempt chain",
      );
    }
    const selected = chain.at(-1);
    const selectedMatches =
      (cell.status === "scored" && selected?.outcome.status === "completed") ||
      (cell.status === "diagnostic_failure" &&
        selected?.outcome.status === "diagnostic_failure") ||
      (cell.status === "infra_unavailable" &&
        (selected?.outcome.status === "infra_failure" ||
          selected?.outcome.status === "interrupted")) ||
      (cell.status === "invalid" && selected?.outcome.status === "invalid");
    if (!selectedMatches || selected === undefined) {
      throw new Error("Benchmark V3 cell status contradicts its attempt");
    }
    if (
      (selected.outcome.status === "diagnostic_failure" &&
        cell.terminalCode !== selected.outcome.code) ||
      (selected.outcome.status === "invalid" &&
        cell.terminalCode !== selected.outcome.code) ||
      (selected.outcome.status === "completed" &&
        (cell.score?.proposalId === null || cell.score?.confidence === null))
    ) {
      throw new Error(
        "Benchmark V3 cell terminal facts contradict its selected attempt",
      );
    }
    if (
      canonicalStringify(cell.metrics) !== canonicalStringify(selected.metrics)
    ) {
      throw new Error("Benchmark V3 cell metrics are not selected metrics");
    }
    if (
      (selected.outcome.status === "completed" ||
        selected.outcome.status === "diagnostic_failure") &&
      selected.outcome.rawManifestHash !== cell.rawManifestHash
    ) {
      throw new Error("Benchmark V3 cell manifest is not selected manifest");
    }
    if (
      (selected.outcome.status === "infra_failure" ||
        selected.outcome.status === "invalid" ||
        selected.outcome.status === "interrupted") &&
      cell.rawManifestHash !== null
    ) {
      throw new Error("Benchmark V3 unscored cell cannot cite a raw manifest");
    }
    if (cell.status === "infra_unavailable") {
      if (
        selected.outcome.status === "infra_failure" &&
        (cell.infrastructureFailure === null ||
          canonicalStringify(cell.infrastructureFailure) !==
            canonicalStringify(selected.outcome.failure) ||
          (selected.outcome.retryable &&
            chain.length < suite.retryPolicy.maxAttemptsPerCell))
      ) {
        throw new Error("Benchmark V3 infrastructure terminal is premature");
      }
      if (
        selected.outcome.status === "interrupted" &&
        (cell.infrastructureFailure?.kind !== "process_interrupted" ||
          chain.length < suite.retryPolicy.maxAttemptsPerCell)
      ) {
        throw new Error("Benchmark V3 interruption terminal is premature");
      }
    }
  }
  return cells;
};

const assertScoringProofs = (
  suite: BenchmarkSuiteSpecV3,
  cells: readonly BenchmarkCellResultV3[],
  attemptsByCell: ReadonlyMap<
    BenchmarkCellId,
    readonly BenchmarkCellAttemptV3[]
  >,
  proofsInput: readonly BenchmarkCellScoringProofV3[],
): readonly BenchmarkCellScoringProofV3[] => {
  const proofs = proofsInput.map((proof) =>
    BenchmarkCellScoringProofV3Schema.parse(proof),
  );
  const eligibleCells = cells.filter(
    (cell) => cell.status === "scored" || cell.status === "diagnostic_failure",
  );
  if (
    proofs.length !== eligibleCells.length ||
    proofs.some((proof, index) => proof.cellId !== eligibleCells[index]?.cellId)
  ) {
    throw new Error(
      "Benchmark V3 scoring proofs must exactly cover eligible cells in schedule order",
    );
  }
  for (const [index, cell] of eligibleCells.entries()) {
    const proof = proofs[index];
    const selected = attemptsByCell.get(cell.cellId)?.at(-1);
    if (proof === undefined || selected === undefined || cell.score === null) {
      throw new Error("Benchmark V3 scoring proof lineage is incomplete");
    }
    const recomputed = assertBenchmarkCellScoringProofV3Integrity({
      suite,
      attempt: selected,
      cell,
      proof,
    });
    if (!sameJson(recomputed, cell.score)) {
      throw new Error("Benchmark V3 cell score contradicts its scoring proof");
    }
  }
  return proofs;
};

const sum = <T>(values: readonly T[], select: (value: T) => number): number =>
  values.reduce((total, value) => total + select(value), 0);

const aggregateArm = (
  cells: readonly BenchmarkCellResultV3[],
  attempts: readonly BenchmarkCellAttemptV3[],
): BenchmarkArmAggregateV3 => {
  const scores = cells.flatMap((cell) =>
    cell.score === null ? [] : [cell.score],
  );
  const coverageComplete = scores.length === 12;
  const groundedSuccesses = scores.filter(
    (score) => score.groundedSuccess,
  ).length;
  const mechanismCorrect = scores.filter(
    (score) => score.mechanismCorrect,
  ).length;
  const sourceScores = scores.filter(
    (score) => score.sourceLocationCorrect !== null,
  );
  return {
    expectedCells: 12,
    scoreEligibleCells: scores.length,
    infraUnavailableCells: cells.filter(
      (cell) => cell.status === "infra_unavailable",
    ).length,
    diagnosticFailureCells: cells.filter(
      (cell) => cell.status === "diagnostic_failure",
    ).length,
    groundedSuccesses,
    groundedSuccessRate: coverageComplete ? groundedSuccesses / 12 : null,
    mechanismCorrect,
    mechanismAccuracy: coverageComplete ? mechanismCorrect / 12 : null,
    incorrectConfirmations: scores.filter(
      (score) => score.incorrectConfirmation,
    ).length,
    sourceCorrect: sourceScores.filter(
      (score) => score.sourceLocationCorrect === true,
    ).length,
    sourceAssessed: sourceScores.length,
    totalGameExecutions: sum(
      attempts,
      (attempt) => attempt.metrics.gameExecutions,
    ),
    totalToolCalls: sum(attempts, (attempt) => attempt.metrics.toolCalls),
    totalWallTimeMs: sum(attempts, (attempt) => attempt.metrics.wallTimeMs),
    totalTokens: sum(attempts, (attempt) => attempt.metrics.tokens.total),
  };
};

export function aggregateBenchmarkV3(
  suiteInput: BenchmarkSuiteSpecV3,
  cells: readonly BenchmarkCellResultV3[],
  attempts: readonly BenchmarkCellAttemptV3[],
): BenchmarkAggregateV3 {
  const suite = assertBenchmarkSuiteSpecV3Integrity(suiteInput);
  const generic = aggregateArm(
    cells.filter((cell) => cell.arm === "generic"),
    attempts.filter((attempt) => attempt.arm === "generic"),
  );
  const evidenceOnly = aggregateArm(
    cells.filter((cell) => cell.arm === "evidence-only"),
    attempts.filter((attempt) => attempt.arm === "evidence-only"),
  );
  const chronoriftFull = aggregateArm(
    cells.filter((cell) => cell.arm === "chronorift-full"),
    attempts.filter((attempt) => attempt.arm === "chronorift-full"),
  );
  const coverageComplete =
    generic.scoreEligibleCells ===
      suite.gate.requiredScoreEligibleCellsByArm.generic &&
    evidenceOnly.scoreEligibleCells ===
      suite.gate.requiredScoreEligibleCellsByArm.evidenceOnly &&
    chronoriftFull.scoreEligibleCells ===
      suite.gate.requiredScoreEligibleCellsByArm.chronoriftFull;
  const fullRate = chronoriftFull.groundedSuccessRate;
  const genericRate = generic.groundedSuccessRate;
  const delta =
    coverageComplete && fullRate !== null && genericRate !== null
      ? fullRate - genericRate
      : null;
  return {
    expectedCells: 36,
    terminalCells: cells.length,
    scoreEligibleCells:
      generic.scoreEligibleCells +
      evidenceOnly.scoreEligibleCells +
      chronoriftFull.scoreEligibleCells,
    byArm: { generic, evidenceOnly, chronoriftFull },
    advantage:
      delta === null || fullRate === null || genericRate === null
        ? null
        : {
            fullGroundedSuccesses: chronoriftFull.groundedSuccesses,
            fullGroundedSuccessRate: fullRate,
            genericGroundedSuccessRate: genericRate,
            fullMinusGeneric: delta,
            fullIncorrectConfirmations: chronoriftFull.incorrectConfirmations,
            thresholdMet:
              chronoriftFull.groundedSuccesses >=
                suite.gate.fullRequiredGroundedSuccesses &&
              delta >= suite.gate.minimumFullMinusGeneric &&
              chronoriftFull.incorrectConfirmations <=
                suite.gate.fullMaximumIncorrectConfirmations,
          },
  };
}

export function buildBenchmarkReportV3(
  options: BuildBenchmarkReportV3Options,
): BenchmarkReportV3 {
  const suite = assertBenchmarkSuiteSpecV3Integrity(options.suite);
  const reportStartedAt = Date.parse(options.startedAt);
  const reportFinishedAt = Date.parse(options.finishedAt);
  if (
    !Number.isFinite(reportStartedAt) ||
    !Number.isFinite(reportFinishedAt) ||
    reportFinishedAt < reportStartedAt
  ) {
    throw new Error("Benchmark V3 report time envelope is invalid");
  }
  const firstAttempt = options.attempts[0];
  const lastAttempt = options.attempts.at(-1);
  if (
    (firstAttempt !== undefined &&
      Date.parse(firstAttempt.startedAt) < reportStartedAt) ||
    (lastAttempt !== undefined &&
      Date.parse(lastAttempt.finishedAt) > reportFinishedAt)
  ) {
    throw new Error("Benchmark V3 attempts fall outside the report envelope");
  }
  const expected = expectedCells(suite);
  const attemptsByCell = assertAttempts(
    suite,
    options.executionId,
    options.attempts,
    expected,
  );
  const cells = assertCells(
    suite,
    options.executionId,
    options.cells,
    expected,
    attemptsByCell,
  );
  const scoringProofs = assertScoringProofs(
    suite,
    cells,
    attemptsByCell,
    options.scoringProofs,
  );
  const hasInvalid =
    (options.auditIssues?.length ?? 0) > 0 ||
    cells.some((cell) => cell.status === "invalid") ||
    options.attempts.some((attempt) => attempt.outcome.status === "invalid");
  const status = hasInvalid
    ? "invalid"
    : cells.length === expected.size
      ? "complete"
      : "incomplete";
  const basis: BenchmarkReportHashBasisV3 = {
    schemaVersion: 3,
    suite,
    executionId: options.executionId,
    selectionHash: benchmarkExecutionSelectionHashV3(
      suite.definitionId,
      options.executionId,
    ),
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    provenance: options.provenance,
    attempts: [...options.attempts],
    cells: [...cells],
    scoringProofs: [...scoringProofs],
    auditIssues: [...(options.auditIssues ?? [])],
    status,
    aggregate:
      status === "complete"
        ? aggregateBenchmarkV3(suite, cells, options.attempts)
        : null,
  };
  return BenchmarkReportV3Schema.parse({
    ...basis,
    reportHash: benchmarkReportHashV3(basis),
  });
}

export function evaluateBenchmarkGateV3(
  reportInput: BenchmarkReportV3,
): BenchmarkGateEvaluationV3 {
  const report = BenchmarkReportV3Schema.parse(reportInput);
  if (report.status !== "complete" || report.aggregate === null) {
    return {
      status: "not_evaluated",
      reasons: ["Benchmark V3 execution is incomplete or invalid"],
    };
  }
  const coverageReasons: string[] = [];
  for (const [arm, aggregate, required] of [
    [
      "generic",
      report.aggregate.byArm.generic,
      report.suite.gate.requiredScoreEligibleCellsByArm.generic,
    ],
    [
      "evidence-only",
      report.aggregate.byArm.evidenceOnly,
      report.suite.gate.requiredScoreEligibleCellsByArm.evidenceOnly,
    ],
    [
      "chronorift-full",
      report.aggregate.byArm.chronoriftFull,
      report.suite.gate.requiredScoreEligibleCellsByArm.chronoriftFull,
    ],
  ] as const) {
    if (aggregate.scoreEligibleCells < required) {
      coverageReasons.push(
        `${arm} score-eligible cells ${aggregate.scoreEligibleCells}/12 are below ${required}/12`,
      );
    }
  }
  if (coverageReasons.length > 0 || report.aggregate.advantage === null) {
    return {
      status: "not_evaluated",
      reasons:
        coverageReasons.length > 0
          ? coverageReasons
          : ["Benchmark V3 advantage is unavailable"],
    };
  }
  const reasons: string[] = [];
  const advantage = report.aggregate.advantage;
  if (
    advantage.fullGroundedSuccesses <
    report.suite.gate.fullRequiredGroundedSuccesses
  ) {
    reasons.push(
      `ChronoRift full grounded successes ${advantage.fullGroundedSuccesses}/12 are below ${report.suite.gate.fullRequiredGroundedSuccesses}/12`,
    );
  }
  if (advantage.fullMinusGeneric < report.suite.gate.minimumFullMinusGeneric) {
    reasons.push(
      `ChronoRift full minus generic is below ${report.suite.gate.minimumFullMinusGeneric}`,
    );
  }
  if (
    advantage.fullIncorrectConfirmations >
    report.suite.gate.fullMaximumIncorrectConfirmations
  ) {
    reasons.push("ChronoRift full emitted an incorrect confirmation");
  }
  return { status: reasons.length === 0 ? "pass" : "fail", reasons };
}

export type BenchmarkReportVerificationV3 =
  | {
      readonly valid: true;
      readonly report: BenchmarkReportV3;
      readonly gate: BenchmarkGateEvaluationV3;
      readonly issues: readonly [];
    }
  | {
      readonly valid: false;
      readonly gate: BenchmarkGateEvaluationV3;
      readonly issues: readonly string[];
    };

export function verifyBenchmarkReportV3(
  input: unknown,
): BenchmarkReportVerificationV3 {
  try {
    const report = BenchmarkReportV3Schema.parse(input);
    const rebuilt = buildBenchmarkReportV3({
      suite: report.suite,
      executionId: report.executionId,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      provenance: report.provenance,
      attempts: report.attempts,
      cells: report.cells,
      scoringProofs: report.scoringProofs,
      auditIssues: report.auditIssues,
    });
    if (
      canonicalStringify(rebuilt as unknown as JsonValue) !==
      canonicalStringify(report as unknown as JsonValue)
    ) {
      throw new Error("Benchmark V3 report does not match recomputation");
    }
    return {
      valid: true,
      report,
      gate: evaluateBenchmarkGateV3(report),
      issues: [],
    };
  } catch (error) {
    return {
      valid: false,
      gate: {
        status: "not_evaluated",
        reasons: ["Benchmark V3 report integrity verification failed"],
      },
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
}
