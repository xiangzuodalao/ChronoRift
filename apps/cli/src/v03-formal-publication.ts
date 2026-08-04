import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";

import {
  DiagnosisProposalV3Schema,
  DiagnosisVerdictV2Schema,
  EvidenceAccessReceiptV1Schema,
  BenchmarkCaseEvidenceV2Schema,
  BenchmarkBaselineProgressManifestV2Schema,
  BenchmarkPublishedCaseBundleV2Schema,
  BenchmarkPublishedCaseEvidenceV2Schema,
  BenchmarkSanitizedProposalV2Schema,
  JsonValueSchema,
  asBenchmarkExecutionId,
  type BenchmarkReportV2,
  type JsonValue,
} from "@chronorift/domain";
import {
  evaluateBenchmarkGateV2,
  verifyBenchmarkReportV2,
} from "@chronorift/gamebranch";
import {
  V03BenchmarkJsonArtifactRepository,
  canonicalJson,
  contentHash,
} from "@chronorift/json-artifacts";

import {
  formalRunnerHash,
  formalSubjectHash,
  parseFormalBenchmarkSuiteSpecV2,
  sameFormalSuite,
} from "./v03-formal-suite.js";

const execFileAsync = promisify(execFile);

export const FORMAL_REPORT_FILENAME = "benchmark-report.v2.json";
export const FORMAL_RESULTS_FILENAME = "results.md";
export const FORMAL_CASE_FILENAME = "case-physics-tunneling-full-r1.json";

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

const isContained = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
};

async function ensureOutputDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  await mkdir(absolute, { recursive: true });
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Benchmark publication output is not a real directory");
  }
  return realpath(absolute);
}

async function writeOnce(path: string, content: string): Promise<void> {
  const parent = await ensureOutputDirectory(dirname(path));
  const finalPath = resolve(path);
  if (!isContained(parent, finalPath)) {
    throw new Error("Benchmark publication path escapes its output directory");
  }
  const temporary = join(
    parent,
    `.${process.pid}-${randomUUID()}.chronorift-publish`,
  );
  let temporaryExists = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, finalPath);
      const directory = await open(parent, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const metadata = await lstat(finalPath);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isFile() ||
        (await readFile(finalPath, "utf8")) !== content
      ) {
        throw new Error(
          `Refusing to replace publication artifact: ${finalPath}`,
        );
      }
    }
  } finally {
    if (temporaryExists) {
      try {
        await unlink(temporary);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }
    }
  }
}

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(resolve(path), "utf8")) as unknown;

export interface VerifyFormalBenchmarkOptions {
  readonly reportPath: string;
  readonly specPath: string;
}

export async function verifyFormalBenchmarkReport(
  options: VerifyFormalBenchmarkOptions,
) {
  const spec = parseFormalBenchmarkSuiteSpecV2(
    await readJson(options.specPath),
  );
  const verification = verifyBenchmarkReportV2(
    await readJson(options.reportPath),
  );
  if (!verification.valid) return verification;
  if (!sameFormalSuite(verification.report.suite, spec)) {
    return {
      valid: false as const,
      gate: {
        status: "not_evaluated" as const,
        reasons: ["Published report does not use the committed suite"],
      },
      issues: ["Benchmark suite differs from the committed specification"],
    };
  }
  const casePath = join(
    dirname(resolve(options.reportPath)),
    FORMAL_CASE_FILENAME,
  );
  try {
    const bundle = BenchmarkPublishedCaseBundleV2Schema.parse(
      await readJson(casePath),
    );
    const { caseHash, ...basis } = bundle;
    const expectedCell = verification.report.cells.find(
      (cell) =>
        cell.fixtureId === spec.preselectedCase.fixtureId &&
        cell.arm === spec.preselectedCase.arm &&
        cell.repetition === spec.preselectedCase.repetition,
    );
    const expectedAttempt =
      expectedCell === undefined
        ? undefined
        : verification.report.attempts.find(
            (attempt) => attempt.attemptId === expectedCell.selectedAttemptId,
          );
    if (
      contentHash(basis as unknown as JsonValue) !== caseHash ||
      bundle.reportHash !== verification.report.reportHash ||
      bundle.selectionHash !== verification.report.selectionHash ||
      bundle.suiteId !== spec.suiteId ||
      bundle.definitionId !== spec.definitionId ||
      bundle.executionId !== verification.report.executionId ||
      canonicalJson(bundle.provenance) !==
        canonicalJson(verification.report.provenance) ||
      canonicalJson(bundle.cell) !== canonicalJson(expectedCell ?? null) ||
      canonicalJson(bundle.attempt) !== canonicalJson(expectedAttempt ?? null)
    ) {
      throw new Error("Published case bundle does not match its report");
    }
  } catch (error) {
    if (
      !isNodeError(error) ||
      error.code !== "ENOENT" ||
      basename(resolve(options.reportPath)) === FORMAL_REPORT_FILENAME
    ) {
      return {
        valid: false as const,
        gate: {
          status: "not_evaluated" as const,
          reasons: ["Published case bundle failed integrity verification"],
        },
        issues: [
          isNodeError(error) && error.code === "ENOENT"
            ? "Published case bundle is missing"
            : error instanceof Error
              ? error.message
              : "Published case bundle is invalid",
        ],
      };
    }
  }
  return verification;
}

const recordOf = (
  value: JsonValue,
  label: string,
): Record<string, JsonValue> => {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} is not an object`);
  }
  return value;
};

const auditFields = [
  "failureBriefHash",
  "failureBriefReceiptId",
  "systemHash",
  "userHash",
  "baselineTimelineDigest",
  "checkpointId",
  "checkpointHash",
  "contractId",
  "contractHash",
  "inputTraceId",
  "inputTraceHash",
  "runtimeFingerprintHash",
  "sourceViewHash",
  "experimentCatalogHash",
  "oracleHash",
] as const;

export function sanitizeFormalProposal(input: unknown): JsonValue {
  const proposal = DiagnosisProposalV3Schema.parse(input);
  return BenchmarkSanitizedProposalV2Schema.parse({
    proposalId: proposal.proposalId,
    runId: proposal.runId,
    fixtureId: proposal.fixtureId,
    capsuleId: proposal.capsuleId,
    baselineExecutionId: proposal.baselineExecutionId,
    replayExecutionId: proposal.replayExecutionId ?? null,
    candidateExecutionIds: proposal.candidateExecutionIds,
    comparisonIds: proposal.comparisonIds,
    accessReceiptIds: proposal.accessReceiptIds,
    mechanismCode: proposal.mechanismCode,
    evidenceEventIds: proposal.evidenceEventIds,
    suspectedSource:
      proposal.suspectedSource === undefined
        ? null
        : {
            path: proposal.suspectedSource.path,
            symbol: proposal.suspectedSource.symbol ?? null,
          },
    confidence: proposal.confidence,
    summaryHash: contentHash(proposal.summary),
    blockersHash: contentHash([...proposal.blockers]),
    nextExperimentHash:
      proposal.nextExperiment === null
        ? null
        : contentHash(proposal.nextExperiment),
  });
}

/** Projects local raw evidence to the small, source-text-free public surface. */
export function sanitizeFormalCaseEvidence(
  rawInput: JsonValue | null,
): JsonValue {
  if (rawInput === null) {
    return BenchmarkPublishedCaseEvidenceV2Schema.parse({
      promptAudit: null,
      proposal: null,
      accessReceipts: [],
      verdict: null,
      gameExecutions: null,
      caseEvidence: null,
      evidenceCompleteness: "unavailable",
      unavailableReason: "raw_manifest_unavailable",
    }) as JsonValue;
  }
  const raw = recordOf(rawInput, "raw attempt manifest");
  if (raw["stage"] === "baseline_completed") {
    const partial = BenchmarkBaselineProgressManifestV2Schema.parse(raw);
    return BenchmarkPublishedCaseEvidenceV2Schema.parse({
      stage: partial.stage,
      promptAudit: null,
      proposal: null,
      accessReceipts: [],
      verdict: null,
      gameExecutions: partial.gameExecutions,
      caseEvidence: null,
      baselineExecutionId: partial.baselineExecutionId,
      baselineTimelineDigest: partial.baselineTimelineDigest,
      evidenceCompleteness: "partial",
      unavailableReason: "attempt_interrupted_after_baseline",
    }) as JsonValue;
  }
  const rawAudit = recordOf(raw["promptAudit"] ?? null, "prompt audit");
  const promptAudit = Object.fromEntries(
    auditFields.map((field) => {
      const value = rawAudit[field];
      if (typeof value !== "string") {
        throw new Error(`Prompt audit ${field} is not a string`);
      }
      return [field, value];
    }),
  );
  const proposal =
    raw["proposal"] === undefined
      ? null
      : DiagnosisProposalV3Schema.parse(raw["proposal"]);
  const rawReceipts = raw["accessReceipts"] ?? [];
  if (!Array.isArray(rawReceipts)) {
    throw new Error("Raw attempt access receipts are not an array");
  }
  const receipts = rawReceipts.map((value) =>
    EvidenceAccessReceiptV1Schema.parse(value),
  );
  const verdict =
    raw["verdict"] === undefined
      ? null
      : DiagnosisVerdictV2Schema.parse(raw["verdict"]);
  const gameExecutions = raw["gameExecutions"];
  if (
    gameExecutions !== undefined &&
    (typeof gameExecutions !== "number" ||
      !Number.isInteger(gameExecutions) ||
      gameExecutions < 0)
  ) {
    throw new Error("Raw attempt game execution count is invalid");
  }
  const caseEvidence = BenchmarkCaseEvidenceV2Schema.parse(raw["caseEvidence"]);
  if (proposal !== null) {
    const executionEvidence = [
      caseEvidence.baseline,
      ...(caseEvidence.replay === null ? [] : [caseEvidence.replay]),
      ...caseEvidence.candidates,
    ];
    const publicEventIds = new Set(
      executionEvidence.flatMap((execution) =>
        execution.causalEvents.map((event) => event.eventId),
      ),
    );
    if (
      proposal.evidenceEventIds.some((eventId) => !publicEventIds.has(eventId))
    ) {
      throw new Error(
        "Proposal evidence event does not resolve in public execution evidence",
      );
    }
    const candidateIds = new Set(
      caseEvidence.candidates.map((execution) => execution.executionId),
    );
    if (
      proposal.candidateExecutionIds.some((id) => !candidateIds.has(id)) ||
      (proposal.replayExecutionId !== undefined &&
        caseEvidence.replay?.executionId !== proposal.replayExecutionId)
    ) {
      throw new Error(
        "Proposal execution references do not resolve in public case evidence",
      );
    }
  }
  const evidenceCompleteness =
    proposal !== null && verdict !== null && raw["piSession"] !== undefined
      ? "complete"
      : "partial";
  return BenchmarkPublishedCaseEvidenceV2Schema.parse({
    promptAudit,
    proposal: proposal === null ? null : sanitizeFormalProposal(proposal),
    accessReceipts: receipts.map((receipt) => ({
      receiptId: receipt.receiptId,
      runId: receipt.runId,
      fixtureId: receipt.fixtureId,
      accessKind: receipt.accessKind,
      resourceId: receipt.resourceId,
      requestHash: receipt.requestHash,
      contentHash: receipt.contentHash,
      sourceCoverage: receipt.sourceCoverage,
      issuedAt: receipt.issuedAt,
    })),
    verdict:
      verdict === null
        ? null
        : {
            verdictId: verdict.verdictId,
            proposalId: verdict.proposalId,
            runId: verdict.runId,
            fixtureId: verdict.fixtureId,
            status: verdict.status,
            mechanismCode: verdict.mechanismCode,
            summaryHash: contentHash(verdict.summary),
            blockersHash: contentHash([...verdict.blockers]),
          },
    gameExecutions: gameExecutions ?? null,
    caseEvidence,
    evidenceCompleteness,
    unavailableReason:
      evidenceCompleteness === "complete"
        ? null
        : "diagnostic_attempt_has_partial_flow_evidence",
  }) as unknown as JsonValue;
}

const markdown = (report: BenchmarkReportV2): string => {
  const gate = evaluateBenchmarkGateV2(report);
  const aggregate = report.aggregate;
  const rows =
    aggregate === null
      ? "No aggregate is available for an incomplete or invalid execution."
      : [
          "| Arm | Grounded success | Mechanism accuracy | Incorrect confirmations | Game executions | Tool calls | Tokens |",
          "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
          ...(
            [
              ["Generic", aggregate.byArm.generic],
              ["Evidence only", aggregate.byArm.evidenceOnly],
              ["ChronoRift full", aggregate.byArm.chronoriftFull],
            ] as const
          ).map(
            ([label, arm]) =>
              `| ${label} | ${arm.groundedSuccesses}/${arm.expectedCells} | ${(arm.mechanismAccuracy * 100).toFixed(1)}% | ${arm.incorrectConfirmations} | ${arm.totalGameExecutions} | ${arm.totalToolCalls} | ${arm.totalTokens} |`,
          ),
        ].join("\n");
  const breakdown = [
    "| Fixture | Arm | Terminal status by repetition | Grounded | Mechanism correct | Confirmed | Attempts | Game executions | Tool calls | Tokens |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.suite.fixtures.flatMap((fixture) =>
      report.suite.arms.map((arm) => {
        const cells = report.cells
          .filter(
            (cell) => cell.fixtureId === fixture.fixtureId && cell.arm === arm,
          )
          .sort((left, right) => left.repetition - right.repetition);
        const attempts = report.attempts.filter(
          (attempt) =>
            attempt.fixtureId === fixture.fixtureId && attempt.arm === arm,
        );
        const statuses = Array.from({ length: 3 }, (_, index) => {
          const cell = cells.find((entry) => entry.repetition === index + 1);
          return `r${index + 1}:${cell?.status ?? "missing"}`;
        }).join(", ");
        const sumMetric = (
          select: (attempt: (typeof attempts)[number]) => number,
        ): number =>
          attempts.reduce((total, attempt) => total + select(attempt), 0);
        return `| ${fixture.fixtureId} | ${arm} | ${statuses} | ${cells.filter((cell) => cell.score?.groundedSuccess === true).length}/3 | ${cells.filter((cell) => cell.score?.mechanismCorrect === true).length}/3 | ${cells.filter((cell) => cell.score?.verdict === "confirmed").length}/3 | ${attempts.length} | ${sumMetric((attempt) => attempt.metrics.gameExecutions)} | ${sumMetric((attempt) => attempt.metrics.toolCalls)} | ${sumMetric((attempt) => attempt.metrics.tokens.total)} |`;
      }),
    ),
  ].join("\n");
  return `# ChronoRift v0.3 formal benchmark results

- Execution: \`${report.executionId}\`
- Report hash: \`${report.reportHash}\`
- First-execution selection hash: \`${report.selectionHash}\`
- Status: **${report.status}**
- Gate: **${gate.status}**
- Frozen metric set: \`${report.suite.metricSet}\`

${rows}

## Fixture × arm breakdown

${breakdown}

This file is generated from \`${FORMAL_REPORT_FILENAME}\`. Run \`corepack pnpm benchmark:verify -- --report <path>\` before interpreting it.
`;
};

export interface PublishFormalBenchmarkOptions {
  readonly cwd: string;
  readonly artifactRoot: string;
  readonly specPath: string;
  readonly executionId: string;
  readonly outputDirectory: string;
  /** Test seam; the CLI never exposes a way to bypass checkout verification. */
  readonly verifyCheckout?:
    | ((
        suite: BenchmarkReportV2["suite"],
        report: BenchmarkReportV2,
        outputDirectory: string,
      ) => Promise<void>)
    | undefined;
}

export function assertPublicationOutputScope(
  cwd: string,
  outputDirectory: string,
  porcelainStatus: string,
): void {
  const output = resolve(outputDirectory);
  const requiredOutput = resolve(cwd, "docs", "benchmarks", "v0.3");
  if (output !== requiredOutput) {
    throw new Error("Formal publication output must be docs/benchmarks/v0.3");
  }
  const allowed = new Set(
    [FORMAL_REPORT_FILENAME, FORMAL_RESULTS_FILENAME, FORMAL_CASE_FILENAME].map(
      (filename) =>
        relative(cwd, join(requiredOutput, filename)).replaceAll("\\", "/"),
    ),
  );
  for (const line of porcelainStatus.split(/\r?\n/u).filter(Boolean)) {
    const path = line.slice(3).trim();
    if (
      path.startsWith('"') ||
      path.includes(" -> ") ||
      !allowed.has(path.replaceAll("\\", "/"))
    ) {
      throw new Error(
        "Publication requires a clean checkout except for its three generated artifacts",
      );
    }
  }
}

async function verifyPublicationCheckout(
  cwd: string,
  suite: BenchmarkReportV2["suite"],
  report: BenchmarkReportV2,
  outputDirectory: string,
): Promise<void> {
  const [subjectHash, runnerHash, head, freezeCommit, status] =
    await Promise.all([
      formalSubjectHash(cwd),
      formalRunnerHash(cwd),
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }),
      execFileAsync(
        "git",
        ["rev-list", "-n", "1", report.provenance.freezeTag],
        { cwd, encoding: "utf8" },
      ),
      execFileAsync(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { cwd, encoding: "utf8" },
      ),
    ]);
  if (
    subjectHash !== suite.subjectHash ||
    runnerHash !== suite.runnerHash ||
    head.stdout.trim() !== report.provenance.gitCommit ||
    freezeCommit.stdout.trim() !== report.provenance.gitCommit
  ) {
    throw new Error("Publication checkout does not match frozen provenance");
  }
  assertPublicationOutputScope(cwd, outputDirectory, status.stdout);
}

export async function publishFormalBenchmark(
  options: PublishFormalBenchmarkOptions,
): Promise<readonly string[]> {
  const suite = parseFormalBenchmarkSuiteSpecV2(
    await readJson(options.specPath),
  );
  const executionId = asBenchmarkExecutionId(options.executionId);
  const repository = new V03BenchmarkJsonArtifactRepository(
    options.artifactRoot,
  );
  const report = await repository.getCompleted(suite.definitionId, executionId);
  if (report === null)
    throw new Error("Formal benchmark execution is not sealed");
  const verification = verifyBenchmarkReportV2(report);
  if (!verification.valid || !sameFormalSuite(report.suite, suite)) {
    throw new Error("Formal benchmark execution failed integrity verification");
  }
  await (
    options.verifyCheckout ??
    ((checkedSuite, checkedReport, outputDirectory) =>
      verifyPublicationCheckout(
        options.cwd,
        checkedSuite,
        checkedReport,
        outputDirectory,
      ))
  )(suite, report, options.outputDirectory);
  const selectedSpec = suite.preselectedCase;
  const cell = report.cells.find(
    (candidate) =>
      candidate.fixtureId === selectedSpec.fixtureId &&
      candidate.arm === selectedSpec.arm &&
      candidate.repetition === selectedSpec.repetition,
  );
  const attempt =
    cell === undefined
      ? undefined
      : report.attempts.find(
          (candidate) => candidate.attemptId === cell.selectedAttemptId,
        );
  const finished =
    cell === undefined || attempt === undefined
      ? null
      : await repository.getAttemptFinished(
          suite.definitionId,
          executionId,
          cell.cellId,
          attempt.ordinal,
          attempt.attemptId,
        );
  const raw =
    finished?.rawManifest === null || finished === null
      ? null
      : finished.rawManifest;
  const caseBasis = JsonValueSchema.parse({
    schemaVersion: 2,
    reportHash: report.reportHash,
    selectionHash: report.selectionHash,
    suiteId: suite.suiteId,
    definitionId: suite.definitionId,
    executionId,
    provenance: report.provenance,
    caseStatus: cell === undefined ? "absent" : "present",
    cell: cell ?? null,
    attempt: attempt ?? null,
    // Explicit allowlist: no credential store, environment, full model request,
    // host path, or Pi session transcript is copied into the publication.
    evidence: sanitizeFormalCaseEvidence(raw),
  });
  const caseBundle = BenchmarkPublishedCaseBundleV2Schema.parse({
    ...recordOf(caseBasis, "case bundle"),
    caseHash: contentHash(caseBasis),
  });
  const output = await ensureOutputDirectory(options.outputDirectory);
  const files = [
    join(output, FORMAL_REPORT_FILENAME),
    join(output, FORMAL_RESULTS_FILENAME),
    join(output, FORMAL_CASE_FILENAME),
  ] as const;
  await writeOnce(files[0], `${canonicalJson(report)}\n`);
  await writeOnce(files[1], markdown(report));
  await writeOnce(
    files[2],
    `${canonicalJson(caseBundle as unknown as JsonValue)}\n`,
  );
  return files;
}
