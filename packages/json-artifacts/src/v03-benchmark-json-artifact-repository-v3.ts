import {
  BenchmarkAttemptFinishedV3Schema,
  BenchmarkAttemptProgressV3Schema,
  BenchmarkAttemptStartedV3Schema,
  BenchmarkCellResultV3Schema,
  BenchmarkExecutionSelectionV3Schema,
  BenchmarkExecutionStartedV3Schema,
  BenchmarkRawAttemptManifestV3Schema,
  BenchmarkReportV3Schema,
  BenchmarkSuiteSpecV3Schema,
  type BenchmarkAttemptFinishedV3,
  type BenchmarkAttemptId,
  type BenchmarkAttemptProgressStateV3,
  type BenchmarkAttemptProgressV3,
  type BenchmarkAttemptStartedV3,
  type BenchmarkCellAttemptV3,
  type BenchmarkCellId,
  type BenchmarkCellResultV3,
  type BenchmarkDefinitionId,
  type BenchmarkExecutionId,
  type BenchmarkExecutionSelectionV3,
  type BenchmarkExecutionStartedV3,
  type JsonValue,
  type BenchmarkReportV3,
  type BenchmarkSuiteSpecV3,
} from "@chronorift/domain";
import {
  assertBenchmarkCellScoringProofV3Integrity,
  assertBenchmarkRawAttemptManifestV3Integrity,
  assertBenchmarkSuiteSpecV3Integrity,
  benchmarkAttemptIdV3,
  benchmarkCellScoringProofFromRawManifestV3,
  benchmarkCellOrderV3,
  benchmarkExecutionSelectionHashV3,
  verifyBenchmarkReportV3,
  type V03BenchmarkArtifactRepositoryV3Port,
} from "@chronorift/gamebranch";

import { canonicalJson, contentHash } from "./canonical-json.js";
import { ArtifactIntegrityError } from "./v01-json-artifact-repository.js";
import { V03BenchmarkJsonLedger } from "./v03-benchmark-json-ledger.js";

interface RuntimeSchema<T> {
  parse(value: unknown): T;
}

const MAX_ATTEMPTS_PER_CELL_V3 = 6;

const exactContentMatches = (left: unknown, right: unknown): boolean =>
  canonicalJson(left as JsonValue) === canonicalJson(right as JsonValue);

const fixtureStageRank = (
  value: BenchmarkAttemptProgressStateV3["fixtureStage"],
): number => (value === "none" ? 0 : value === "baseline_captured" ? 1 : 2);

const assertMonotonicProgress = (
  previous: BenchmarkAttemptProgressV3,
  next: BenchmarkAttemptProgressV3,
): void => {
  const before = previous.progress;
  const after = next.progress;
  const regressed =
    Date.parse(next.observedAt) < Date.parse(previous.observedAt) ||
    fixtureStageRank(after.fixtureStage) <
      fixtureStageRank(before.fixtureStage) ||
    (before.model.requestStarted && !after.model.requestStarted) ||
    (before.model.outputObserved && !after.model.outputObserved) ||
    (before.model.turnCompleted && !after.model.turnCompleted) ||
    after.tools.started < before.tools.started ||
    after.tools.completed < before.tools.completed ||
    after.tools.failed < before.tools.failed ||
    after.tools.semanticRevision < before.tools.semanticRevision ||
    after.game.baselineExecutions < before.game.baselineExecutions ||
    after.game.diagnosticExecutions < before.game.diagnosticExecutions ||
    (before.proposalSubmitted && !after.proposalSubmitted) ||
    next.metrics.gameExecutions < previous.metrics.gameExecutions ||
    next.metrics.toolCalls < previous.metrics.toolCalls ||
    next.metrics.wallTimeMs < previous.metrics.wallTimeMs ||
    next.metrics.tokens.input < previous.metrics.tokens.input ||
    next.metrics.tokens.output < previous.metrics.tokens.output ||
    next.metrics.tokens.cacheRead < previous.metrics.tokens.cacheRead ||
    next.metrics.tokens.cacheWrite < previous.metrics.tokens.cacheWrite ||
    next.metrics.tokens.total < previous.metrics.tokens.total;
  if (regressed) {
    throw new ArtifactIntegrityError(
      `benchmark-attempt-progress:${next.attemptId}`,
    );
  }
};

/** Strict V3 reader/writer over the existing schema-neutral append-only ledger. */
export class V03BenchmarkJsonArtifactRepositoryV3 implements V03BenchmarkArtifactRepositoryV3Port {
  public readonly ledger: V03BenchmarkJsonLedger;

  public constructor(artifactRoot: string) {
    this.ledger = new V03BenchmarkJsonLedger(artifactRoot);
  }

  private parseStored<T>(
    schema: RuntimeSchema<T>,
    value: unknown,
    identity: string,
  ): T {
    try {
      return schema.parse(value);
    } catch {
      throw new ArtifactIntegrityError(identity);
    }
  }

  private assertFinishedIntegrity(
    record: BenchmarkAttemptFinishedV3,
  ): BenchmarkAttemptFinishedV3 {
    const { attemptHash, ...attemptBasis } = record.attempt;
    if (contentHash(attemptBasis) !== attemptHash) {
      throw new ArtifactIntegrityError(record.attempt.attemptId);
    }
    const outcome = record.attempt.outcome;
    if (
      outcome.status === "completed" ||
      outcome.status === "diagnostic_failure"
    ) {
      const manifest = this.parseStored(
        BenchmarkRawAttemptManifestV3Schema,
        record.rawManifest,
        `benchmark-attempt-manifest:${record.attempt.attemptId}`,
      );
      if (
        record.rawManifest === null ||
        manifest.terminalStatus !== outcome.status ||
        manifest.suiteId !== record.attempt.suiteId ||
        manifest.definitionId !== record.attempt.definitionId ||
        manifest.executionId !== record.attempt.executionId ||
        manifest.cellId !== record.attempt.cellId ||
        manifest.attemptId !== record.attempt.attemptId ||
        manifest.fixtureId !== record.attempt.fixtureId ||
        manifest.arm !== record.attempt.arm ||
        manifest.repetition !== record.attempt.repetition ||
        manifest.ordinal !== record.attempt.ordinal ||
        !exactContentMatches(manifest.progress, record.attempt.progress) ||
        !exactContentMatches(manifest.metrics, record.attempt.metrics) ||
        (outcome.status === "diagnostic_failure" &&
          manifest.terminalStatus === "diagnostic_failure" &&
          manifest.diagnosticCode !== outcome.code) ||
        contentHash(record.rawManifest as unknown as JsonValue) !==
          outcome.rawManifestHash ||
        record.terminalCell?.rawManifestHash !== outcome.rawManifestHash
      ) {
        throw new ArtifactIntegrityError(record.attempt.attemptId);
      }
    }
    return record;
  }

  private assertAttemptMatchesStart(
    started: BenchmarkAttemptStartedV3,
    attempt: BenchmarkCellAttemptV3,
  ): void {
    const {
      attemptHash: _attemptHash,
      finishedAt: _finishedAt,
      progress: _progress,
      metrics: _metrics,
      outcome: _outcome,
      ...startBasis
    } = attempt;
    void _attemptHash;
    void _finishedAt;
    void _progress;
    void _metrics;
    void _outcome;
    if (contentHash(startBasis) !== contentHash(started)) {
      throw new ArtifactIntegrityError(attempt.attemptId);
    }
  }

  private async assertCellMatchesFinishedAttempt(
    cell: BenchmarkCellResultV3,
  ): Promise<void> {
    let selected: BenchmarkAttemptFinishedV3 | null = null;
    for (let ordinal = 1; ordinal <= MAX_ATTEMPTS_PER_CELL_V3; ordinal += 1) {
      const candidateAttemptId = benchmarkAttemptIdV3(
        cell.executionId,
        cell.cellId,
        ordinal,
      );
      if (candidateAttemptId !== cell.selectedAttemptId) continue;
      selected = await this.getAttemptFinishedV3(
        cell.definitionId,
        cell.executionId,
        cell.cellId,
        ordinal,
        candidateAttemptId,
      );
      break;
    }
    if (
      selected?.terminalCell === null ||
      selected === null ||
      !exactContentMatches(selected.terminalCell, cell)
    ) {
      throw new ArtifactIntegrityError(cell.cellId);
    }
  }

  private async assertFinishedMatchesProgress(
    record: BenchmarkAttemptFinishedV3,
  ): Promise<void> {
    const attempt = record.attempt;
    const progress = await this.getAttemptProgressV3(
      attempt.definitionId,
      attempt.executionId,
      attempt.cellId,
      attempt.ordinal,
      attempt.attemptId,
    );
    const latest = progress.at(-1);
    if (
      latest === undefined ||
      Date.parse(latest.observedAt) > Date.parse(attempt.finishedAt) ||
      !exactContentMatches(latest.progress, attempt.progress) ||
      !exactContentMatches(latest.metrics, attempt.metrics)
    ) {
      throw new ArtifactIntegrityError(attempt.attemptId);
    }
  }

  private async assertReportLedgerIntegrity(
    report: BenchmarkReportV3,
  ): Promise<void> {
    const definition = await this.getDefinitionV3(report.suite.definitionId);
    if (!exactContentMatches(definition, report.suite)) {
      throw new ArtifactIntegrityError(report.executionId);
    }

    const selection = await this.getExecutionSelectionV3(
      report.suite.definitionId,
    );
    const expectedSelection = BenchmarkExecutionSelectionV3Schema.parse({
      schemaVersion: 3,
      suiteId: report.suite.suiteId,
      definitionId: report.suite.definitionId,
      executionId: report.executionId,
      selectionHash: report.selectionHash,
    });
    if (
      selection === null ||
      !exactContentMatches(selection, expectedSelection)
    ) {
      throw new ArtifactIntegrityError(report.executionId);
    }

    const started = await this.getExecutionStartedV3(
      report.suite.definitionId,
      report.executionId,
    );
    const expectedStart = BenchmarkExecutionStartedV3Schema.parse({
      ...expectedSelection,
      startedAt: report.startedAt,
      provenance: report.provenance,
    });
    if (started === null || !exactContentMatches(started, expectedStart)) {
      throw new ArtifactIntegrityError(report.executionId);
    }

    const reportAttempts = new Map(
      report.attempts.map((attempt) => [attempt.attemptId, attempt] as const),
    );
    const reportCells = new Map(
      report.cells.map((cell) => [cell.cellId, cell] as const),
    );
    const reportProofs = new Map(
      report.scoringProofs.map((proof) => [proof.cellId, proof] as const),
    );
    const storedAttemptIds = new Set<BenchmarkAttemptId>();
    const storedCellIds = new Set<BenchmarkCellId>();
    const storedProofCellIds = new Set<BenchmarkCellId>();

    for (const orderedCell of benchmarkCellOrderV3(report.suite)) {
      const storedCell = await this.getCellV3(
        report.suite.definitionId,
        report.executionId,
        orderedCell.cellId,
      );
      const reportCell = reportCells.get(orderedCell.cellId);
      if (storedCell !== null) {
        if (
          reportCell === undefined ||
          !exactContentMatches(storedCell, reportCell)
        ) {
          throw new ArtifactIntegrityError(orderedCell.cellId);
        }
        storedCellIds.add(orderedCell.cellId);
      } else if (reportCell !== undefined) {
        throw new ArtifactIntegrityError(orderedCell.cellId);
      }

      for (
        let ordinal = 1;
        ordinal <= report.suite.retryPolicy.maxAttemptsPerCell;
        ordinal += 1
      ) {
        const attemptId = benchmarkAttemptIdV3(
          report.executionId,
          orderedCell.cellId,
          ordinal,
        );
        const attemptStarted = await this.getAttemptStartedV3(
          report.suite.definitionId,
          report.executionId,
          orderedCell.cellId,
          ordinal,
          attemptId,
        );
        const attemptFinished = await this.getAttemptFinishedV3(
          report.suite.definitionId,
          report.executionId,
          orderedCell.cellId,
          ordinal,
          attemptId,
        );
        const progress = await this.getAttemptProgressV3(
          report.suite.definitionId,
          report.executionId,
          orderedCell.cellId,
          ordinal,
          attemptId,
        );
        if (attemptStarted === null) {
          if (attemptFinished !== null || progress.length > 0) {
            throw new ArtifactIntegrityError(attemptId);
          }
          continue;
        }
        if (attemptFinished === null) {
          throw new ArtifactIntegrityError(attemptId);
        }
        const reportAttempt = reportAttempts.get(attemptId);
        if (
          reportAttempt === undefined ||
          !exactContentMatches(attemptFinished.attempt, reportAttempt)
        ) {
          throw new ArtifactIntegrityError(attemptId);
        }
        if (attemptFinished.rawManifest !== null) {
          try {
            const terminalCell = attemptFinished.terminalCell;
            const reportProof = reportProofs.get(orderedCell.cellId);
            const projectedProof = benchmarkCellScoringProofFromRawManifestV3(
              attemptFinished.rawManifest,
            );
            if (
              terminalCell === null ||
              terminalCell.score === null ||
              reportProof === undefined ||
              !exactContentMatches(projectedProof, reportProof)
            ) {
              throw new ArtifactIntegrityError(attemptId);
            }
            const verified = assertBenchmarkRawAttemptManifestV3Integrity({
              suite: report.suite,
              attempt: attemptFinished.attempt,
              manifest: attemptFinished.rawManifest,
            });
            const proofScore = assertBenchmarkCellScoringProofV3Integrity({
              suite: report.suite,
              attempt: attemptFinished.attempt,
              cell: terminalCell,
              proof: reportProof,
            });
            if (
              !exactContentMatches(verified.score, terminalCell.score) ||
              !exactContentMatches(proofScore, terminalCell.score)
            ) {
              throw new ArtifactIntegrityError(attemptId);
            }
            storedProofCellIds.add(orderedCell.cellId);
          } catch {
            throw new ArtifactIntegrityError(attemptId);
          }
        }
        storedAttemptIds.add(attemptId);
      }
    }

    if (
      storedAttemptIds.size !== reportAttempts.size ||
      storedCellIds.size !== reportCells.size ||
      storedProofCellIds.size !== reportProofs.size ||
      [...reportAttempts.keys()].some(
        (attemptId) => !storedAttemptIds.has(attemptId),
      ) ||
      [...reportCells.keys()].some((cellId) => !storedCellIds.has(cellId)) ||
      [...reportProofs.keys()].some((cellId) => !storedProofCellIds.has(cellId))
    ) {
      throw new ArtifactIntegrityError(report.executionId);
    }
  }

  public putDefinitionV3(spec: BenchmarkSuiteSpecV3): Promise<void> {
    let parsed: BenchmarkSuiteSpecV3;
    try {
      parsed = assertBenchmarkSuiteSpecV3Integrity(
        BenchmarkSuiteSpecV3Schema.parse(spec),
      );
    } catch {
      throw new ArtifactIntegrityError(
        `benchmark-definition:${spec.definitionId}`,
      );
    }
    return this.ledger.writeDefinition(parsed.definitionId, parsed);
  }

  public async getDefinitionV3(
    id: BenchmarkDefinitionId,
  ): Promise<BenchmarkSuiteSpecV3> {
    let parsed: BenchmarkSuiteSpecV3;
    try {
      parsed = assertBenchmarkSuiteSpecV3Integrity(
        this.parseStored(
          BenchmarkSuiteSpecV3Schema,
          await this.ledger.readDefinition(id),
          `benchmark-definition:${id}`,
        ),
      );
    } catch {
      throw new ArtifactIntegrityError(`benchmark-definition:${id}`);
    }
    if (parsed.definitionId !== id) throw new ArtifactIntegrityError(id);
    return parsed;
  }

  public putExecutionSelectionV3(
    record: BenchmarkExecutionSelectionV3,
  ): Promise<void> {
    const parsed = BenchmarkExecutionSelectionV3Schema.parse(record);
    if (
      parsed.selectionHash !==
      benchmarkExecutionSelectionHashV3(parsed.definitionId, parsed.executionId)
    ) {
      throw new ArtifactIntegrityError(parsed.executionId);
    }
    return this.ledger.writeExecutionSelection(parsed.definitionId, parsed);
  }

  public async getExecutionSelectionV3(
    definitionId: BenchmarkDefinitionId,
  ): Promise<BenchmarkExecutionSelectionV3 | null> {
    const value = await this.ledger.tryReadExecutionSelection(definitionId);
    const parsed =
      value === null
        ? null
        : this.parseStored(
            BenchmarkExecutionSelectionV3Schema,
            value,
            `benchmark-execution-selection:${definitionId}`,
          );
    if (parsed !== null && parsed.definitionId !== definitionId) {
      throw new ArtifactIntegrityError(definitionId);
    }
    if (
      parsed !== null &&
      parsed.selectionHash !==
        benchmarkExecutionSelectionHashV3(
          parsed.definitionId,
          parsed.executionId,
        )
    ) {
      throw new ArtifactIntegrityError(parsed.executionId);
    }
    return parsed;
  }

  public putExecutionStartedV3(
    record: BenchmarkExecutionStartedV3,
  ): Promise<void> {
    const parsed = BenchmarkExecutionStartedV3Schema.parse(record);
    if (
      parsed.selectionHash !==
      benchmarkExecutionSelectionHashV3(parsed.definitionId, parsed.executionId)
    ) {
      throw new ArtifactIntegrityError(parsed.executionId);
    }
    return this.ledger.writeExecutionStarted(
      parsed.definitionId,
      parsed.executionId,
      parsed,
    );
  }

  public async getExecutionStartedV3(
    definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
  ): Promise<BenchmarkExecutionStartedV3 | null> {
    const value = await this.ledger.tryReadExecutionStarted(
      definitionId,
      executionId,
    );
    const parsed =
      value === null
        ? null
        : this.parseStored(
            BenchmarkExecutionStartedV3Schema,
            value,
            `benchmark-execution-started:${executionId}`,
          );
    if (
      parsed !== null &&
      (parsed.definitionId !== definitionId ||
        parsed.executionId !== executionId)
    ) {
      throw new ArtifactIntegrityError(executionId);
    }
    if (
      parsed !== null &&
      parsed.selectionHash !==
        benchmarkExecutionSelectionHashV3(
          parsed.definitionId,
          parsed.executionId,
        )
    ) {
      throw new ArtifactIntegrityError(executionId);
    }
    return parsed;
  }

  public putAttemptStartedV3(record: BenchmarkAttemptStartedV3): Promise<void> {
    const parsed = BenchmarkAttemptStartedV3Schema.parse(record);
    if (
      parsed.attemptId !==
      benchmarkAttemptIdV3(parsed.executionId, parsed.cellId, parsed.ordinal)
    ) {
      throw new ArtifactIntegrityError(parsed.attemptId);
    }
    return this.ledger.writeAttemptStarted(
      parsed.definitionId,
      parsed.executionId,
      parsed.cellId,
      parsed.ordinal,
      parsed.attemptId,
      parsed,
    );
  }

  public async getAttemptStartedV3(
    definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
    cellId: BenchmarkCellId,
    ordinal: number,
    attemptId: BenchmarkAttemptId,
  ): Promise<BenchmarkAttemptStartedV3 | null> {
    const value = await this.ledger.tryReadAttemptStarted(
      definitionId,
      executionId,
      cellId,
      ordinal,
      attemptId,
    );
    const parsed =
      value === null
        ? null
        : this.parseStored(
            BenchmarkAttemptStartedV3Schema,
            value,
            `benchmark-attempt-started:${attemptId}`,
          );
    if (
      parsed !== null &&
      (parsed.definitionId !== definitionId ||
        parsed.executionId !== executionId ||
        parsed.cellId !== cellId ||
        parsed.ordinal !== ordinal ||
        parsed.attemptId !== attemptId)
    ) {
      throw new ArtifactIntegrityError(attemptId);
    }
    if (
      parsed !== null &&
      parsed.attemptId !==
        benchmarkAttemptIdV3(parsed.executionId, parsed.cellId, parsed.ordinal)
    ) {
      throw new ArtifactIntegrityError(attemptId);
    }
    return parsed;
  }

  public async putAttemptProgressV3(
    record: BenchmarkAttemptProgressV3,
  ): Promise<void> {
    const parsed = BenchmarkAttemptProgressV3Schema.parse(record);
    const started = await this.getAttemptStartedV3(
      parsed.definitionId,
      parsed.executionId,
      parsed.cellId,
      parsed.ordinal,
      parsed.attemptId,
    );
    if (started === null) {
      throw new ArtifactIntegrityError(parsed.attemptId);
    }
    if (
      (await this.getAttemptFinishedV3(
        parsed.definitionId,
        parsed.executionId,
        parsed.cellId,
        parsed.ordinal,
        parsed.attemptId,
      )) !== null
    ) {
      throw new ArtifactIntegrityError(parsed.attemptId);
    }
    const existing = await this.getAttemptProgressV3(
      parsed.definitionId,
      parsed.executionId,
      parsed.cellId,
      parsed.ordinal,
      parsed.attemptId,
    );
    const priorAtSequence = existing[parsed.sequence - 1];
    if (priorAtSequence !== undefined) {
      if (contentHash(priorAtSequence) !== contentHash(parsed)) {
        throw new ArtifactIntegrityError(parsed.attemptId);
      }
    } else {
      if (parsed.sequence !== existing.length + 1) {
        throw new ArtifactIntegrityError(parsed.attemptId);
      }
      const previous = existing.at(-1);
      if (previous !== undefined) assertMonotonicProgress(previous, parsed);
    }
    await this.ledger.writeAttemptProgress(
      parsed.definitionId,
      parsed.executionId,
      parsed.cellId,
      parsed.ordinal,
      parsed.attemptId,
      parsed.sequence,
      parsed,
    );
  }

  public async getAttemptProgressV3(
    definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
    cellId: BenchmarkCellId,
    ordinal: number,
    attemptId: BenchmarkAttemptId,
  ): Promise<readonly BenchmarkAttemptProgressV3[]> {
    const values = await this.ledger.listAttemptProgress(
      definitionId,
      executionId,
      cellId,
      ordinal,
      attemptId,
    );
    if (
      values.length > 0 &&
      (await this.getAttemptStartedV3(
        definitionId,
        executionId,
        cellId,
        ordinal,
        attemptId,
      )) === null
    ) {
      throw new ArtifactIntegrityError(attemptId);
    }
    const records = values.map((value, index) => {
      const record = this.parseStored(
        BenchmarkAttemptProgressV3Schema,
        value,
        `benchmark-attempt-progress:${attemptId}:${index + 1}`,
      );
      if (
        record.definitionId !== definitionId ||
        record.executionId !== executionId ||
        record.cellId !== cellId ||
        record.ordinal !== ordinal ||
        record.attemptId !== attemptId ||
        record.sequence !== index + 1
      ) {
        throw new ArtifactIntegrityError(attemptId);
      }
      return record;
    });
    for (let index = 1; index < records.length; index += 1) {
      const previous = records[index - 1];
      const next = records[index];
      if (previous === undefined || next === undefined) {
        throw new ArtifactIntegrityError(attemptId);
      }
      assertMonotonicProgress(previous, next);
    }
    return records;
  }

  public async putAttemptFinishedV3(
    record: BenchmarkAttemptFinishedV3,
  ): Promise<void> {
    const parsed = this.assertFinishedIntegrity(
      BenchmarkAttemptFinishedV3Schema.parse(record),
    );
    const started = await this.getAttemptStartedV3(
      parsed.attempt.definitionId,
      parsed.attempt.executionId,
      parsed.attempt.cellId,
      parsed.attempt.ordinal,
      parsed.attempt.attemptId,
    );
    if (started === null) {
      throw new ArtifactIntegrityError(parsed.attempt.attemptId);
    }
    this.assertAttemptMatchesStart(started, parsed.attempt);
    const progress = await this.getAttemptProgressV3(
      parsed.attempt.definitionId,
      parsed.attempt.executionId,
      parsed.attempt.cellId,
      parsed.attempt.ordinal,
      parsed.attempt.attemptId,
    );
    const latest = progress.at(-1);
    if (latest !== undefined) {
      assertMonotonicProgress(latest, {
        ...latest,
        sequence: latest.sequence + 1,
        observedAt: parsed.attempt.finishedAt,
        progress: parsed.attempt.progress,
        metrics: parsed.attempt.metrics,
      });
    }
    await this.assertFinishedMatchesProgress(parsed);
    await this.ledger.writeAttemptFinished(
      parsed.attempt.definitionId,
      parsed.attempt.executionId,
      parsed.attempt.cellId,
      parsed.attempt.ordinal,
      parsed.attempt.attemptId,
      parsed as unknown as JsonValue,
    );
  }

  public async getAttemptFinishedV3(
    definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
    cellId: BenchmarkCellId,
    ordinal: number,
    attemptId: BenchmarkAttemptId,
  ): Promise<BenchmarkAttemptFinishedV3 | null> {
    const value = await this.ledger.tryReadAttemptFinished(
      definitionId,
      executionId,
      cellId,
      ordinal,
      attemptId,
    );
    const parsed =
      value === null
        ? null
        : this.assertFinishedIntegrity(
            this.parseStored(
              BenchmarkAttemptFinishedV3Schema,
              value,
              `benchmark-attempt-finished:${attemptId}`,
            ),
          );
    if (
      parsed !== null &&
      (parsed.attempt.definitionId !== definitionId ||
        parsed.attempt.executionId !== executionId ||
        parsed.attempt.cellId !== cellId ||
        parsed.attempt.ordinal !== ordinal ||
        parsed.attempt.attemptId !== attemptId)
    ) {
      throw new ArtifactIntegrityError(attemptId);
    }
    if (parsed !== null) {
      const started = await this.getAttemptStartedV3(
        definitionId,
        executionId,
        cellId,
        ordinal,
        attemptId,
      );
      if (started === null) throw new ArtifactIntegrityError(attemptId);
      this.assertAttemptMatchesStart(started, parsed.attempt);
      await this.assertFinishedMatchesProgress(parsed);
    }
    return parsed;
  }

  public async putCellV3(record: BenchmarkCellResultV3): Promise<void> {
    const parsed = BenchmarkCellResultV3Schema.parse(record);
    await this.assertCellMatchesFinishedAttempt(parsed);
    await this.ledger.writeCell(
      parsed.definitionId,
      parsed.executionId,
      parsed.cellId,
      parsed,
    );
  }

  public async getCellV3(
    definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
    cellId: BenchmarkCellId,
  ): Promise<BenchmarkCellResultV3 | null> {
    const value = await this.ledger.tryReadCell(
      definitionId,
      executionId,
      cellId,
    );
    const parsed =
      value === null
        ? null
        : this.parseStored(
            BenchmarkCellResultV3Schema,
            value,
            `benchmark-cell:${cellId}`,
          );
    if (
      parsed !== null &&
      (parsed.definitionId !== definitionId ||
        parsed.executionId !== executionId ||
        parsed.cellId !== cellId)
    ) {
      throw new ArtifactIntegrityError(cellId);
    }
    if (parsed !== null) await this.assertCellMatchesFinishedAttempt(parsed);
    return parsed;
  }

  public async putCompletedV3(report: BenchmarkReportV3): Promise<void> {
    const parsed = BenchmarkReportV3Schema.parse(report);
    if (!verifyBenchmarkReportV3(parsed).valid) {
      throw new ArtifactIntegrityError(parsed.executionId);
    }
    await this.assertReportLedgerIntegrity(parsed);
    await this.ledger.writeExecutionCompleted(
      parsed.suite.definitionId,
      parsed.executionId,
      parsed as unknown as JsonValue,
    );
  }

  public async getCompletedV3(
    definitionId: BenchmarkDefinitionId,
    executionId: BenchmarkExecutionId,
  ): Promise<BenchmarkReportV3 | null> {
    const value = await this.ledger.tryReadExecutionCompleted(
      definitionId,
      executionId,
    );
    const parsed =
      value === null
        ? null
        : this.parseStored(
            BenchmarkReportV3Schema,
            value,
            `benchmark-execution-completed:${executionId}`,
          );
    if (
      parsed !== null &&
      (parsed.suite.definitionId !== definitionId ||
        parsed.executionId !== executionId)
    ) {
      throw new ArtifactIntegrityError(executionId);
    }
    if (parsed !== null && !verifyBenchmarkReportV3(parsed).valid) {
      throw new ArtifactIntegrityError(executionId);
    }
    if (parsed !== null) await this.assertReportLedgerIntegrity(parsed);
    return parsed;
  }
}
