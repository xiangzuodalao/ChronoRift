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
  win32,
} from "node:path";
import { promisify } from "node:util";

import {
  BenchmarkPublishedCaseBundleV3Schema,
  JsonValueSchema,
  asBenchmarkExecutionId,
  type BenchmarkReportV3,
  type JsonValue,
} from "@chronorift/domain";
import {
  evaluateBenchmarkGateV3,
  verifyBenchmarkReportV3,
} from "@chronorift/gamebranch";
import {
  V03BenchmarkJsonArtifactRepositoryV3,
  canonicalJson,
  contentHash,
} from "@chronorift/json-artifacts";

import { sanitizeFormalCaseEvidence } from "./v03-formal-publication.js";
import {
  formalCampaignForSuiteV3,
  formalRunnerHash,
  formalSubjectHash,
  parseFormalBenchmarkSuiteSpecV3,
  sameFormalSuiteV3,
} from "./v03-formal-suite.js";

const execFileAsync = promisify(execFile);

export const FORMAL_REPORT_FILENAME_V3 = "benchmark-report.v3.json";
export const FORMAL_RESULTS_FILENAME_V3 = "results.md";
export const FORMAL_CASE_FILENAME_V3 = "case-physics-tunneling-full-r1.json";

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
    throw new Error("Benchmark V3 publication output is not a real directory");
  }
  return realpath(absolute);
}

async function writeOnce(path: string, content: string): Promise<void> {
  const parent = await ensureOutputDirectory(dirname(path));
  const finalPath = resolve(path);
  if (!isContained(parent, finalPath)) {
    throw new Error(
      "Benchmark V3 publication path escapes its output directory",
    );
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
          `Refusing to replace V3 publication artifact: ${finalPath}`,
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

const forbiddenPublicKeys = new Set([
  "accesstoken",
  "apikey",
  "artifactroot",
  "authorization",
  "authjson",
  "authtoken",
  "credential",
  "credentials",
  "credentialstore",
  "cwd",
  "modelrequest",
  "password",
  "pisession",
  "providerrequest",
  "rawrequest",
  "rawresponse",
  "refreshtoken",
  "rundir",
  "rundirectory",
  "secret",
  "session",
  "sessiontranscript",
  "sourcetext",
  "token",
]);

function assertPublicProjection(value: JsonValue, key = "root"): void {
  if (typeof value === "string") {
    const normalizedKey = key.toLowerCase();
    if (
      (normalizedKey.endsWith("path") || normalizedKey === "resourceid") &&
      (isAbsolute(value) ||
        win32.isAbsolute(value) ||
        value.split(/[\\/]/u).includes(".."))
    ) {
      throw new Error("Published V3 case contains an unsafe host path");
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) assertPublicProjection(entry, key);
    return;
  }
  for (const [field, entry] of Object.entries(value)) {
    if (forbiddenPublicKeys.has(field.toLowerCase())) {
      throw new Error(`Published V3 case contains forbidden field: ${field}`);
    }
    assertPublicProjection(entry, field);
  }
}

export function assertFormalPublicationProjectionV3(value: JsonValue): void {
  assertPublicProjection(value);
}

export interface VerifyFormalBenchmarkV3Options {
  readonly reportPath: string;
  readonly specPath: string;
}

export async function verifyFormalBenchmarkReportV3(
  options: VerifyFormalBenchmarkV3Options,
) {
  const suite = parseFormalBenchmarkSuiteSpecV3(
    await readJson(options.specPath),
  );
  const verification = verifyBenchmarkReportV3(
    await readJson(options.reportPath),
  );
  if (!verification.valid) return verification;
  if (!sameFormalSuiteV3(verification.report.suite, suite)) {
    return {
      valid: false as const,
      gate: {
        status: "not_evaluated" as const,
        reasons: ["Published V3 report does not use the committed suite"],
      },
      issues: ["Benchmark V3 suite differs from the committed specification"],
    };
  }
  const casePath = join(
    dirname(resolve(options.reportPath)),
    FORMAL_CASE_FILENAME_V3,
  );
  try {
    const bundle = BenchmarkPublishedCaseBundleV3Schema.parse(
      await readJson(casePath),
    );
    const { caseHash, ...basis } = bundle;
    const expectedCell = verification.report.cells.find(
      (cell) =>
        cell.fixtureId === suite.preselectedCase.fixtureId &&
        cell.arm === suite.preselectedCase.arm &&
        cell.repetition === suite.preselectedCase.repetition,
    );
    const expectedAttempt =
      expectedCell === undefined
        ? undefined
        : verification.report.attempts.find(
            (attempt) => attempt.attemptId === expectedCell.selectedAttemptId,
          );
    assertPublicProjection(bundle as unknown as JsonValue);
    if (
      contentHash(basis as unknown as JsonValue) !== caseHash ||
      bundle.reportHash !== verification.report.reportHash ||
      bundle.selectionHash !== verification.report.selectionHash ||
      bundle.suiteId !== suite.suiteId ||
      bundle.definitionId !== suite.definitionId ||
      bundle.executionId !== verification.report.executionId ||
      canonicalJson(bundle.provenance) !==
        canonicalJson(verification.report.provenance) ||
      canonicalJson(bundle.cell) !== canonicalJson(expectedCell ?? null) ||
      canonicalJson(bundle.attempt) !== canonicalJson(expectedAttempt ?? null)
    ) {
      throw new Error("Published V3 case bundle does not match its report");
    }
  } catch (error) {
    if (
      !isNodeError(error) ||
      error.code !== "ENOENT" ||
      basename(resolve(options.reportPath)) === FORMAL_REPORT_FILENAME_V3
    ) {
      return {
        valid: false as const,
        gate: {
          status: "not_evaluated" as const,
          reasons: ["Published V3 case bundle failed integrity verification"],
        },
        issues: [
          isNodeError(error) && error.code === "ENOENT"
            ? "Published V3 case bundle is missing"
            : error instanceof Error
              ? error.message
              : "Published V3 case bundle is invalid",
        ],
      };
    }
  }
  return verification;
}

const percent = (value: number | null): string =>
  value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;

const markdown = (report: BenchmarkReportV3): string => {
  const gate = evaluateBenchmarkGateV3(report);
  const aggregate = report.aggregate;
  const rows =
    aggregate === null
      ? "No aggregate is available for an incomplete or invalid execution."
      : [
          "| Arm | Score eligible | Infra unavailable | Grounded success | Mechanism accuracy | Incorrect confirmations | Game executions | Tool calls | Tokens |",
          "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
          ...(
            [
              ["Generic", aggregate.byArm.generic],
              ["Evidence only", aggregate.byArm.evidenceOnly],
              ["ChronoRift full", aggregate.byArm.chronoriftFull],
            ] as const
          ).map(
            ([label, arm]) =>
              `| ${label} | ${arm.scoreEligibleCells}/${arm.expectedCells} | ${arm.infraUnavailableCells} | ${arm.groundedSuccesses}/${arm.scoreEligibleCells} | ${percent(arm.mechanismAccuracy)} | ${arm.incorrectConfirmations} | ${arm.totalGameExecutions} | ${arm.totalToolCalls} | ${arm.totalTokens} |`,
          ),
        ].join("\n");
  const breakdown = [
    "| Fixture | Arm | Terminal status by repetition | Grounded | Attempts | Game executions | Tool calls | Tokens |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
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
        return `| ${fixture.fixtureId} | ${arm} | ${statuses} | ${cells.filter((cell) => cell.score?.groundedSuccess === true).length}/3 | ${attempts.length} | ${sumMetric((attempt) => attempt.metrics.gameExecutions)} | ${sumMetric((attempt) => attempt.metrics.toolCalls)} | ${sumMetric((attempt) => attempt.metrics.tokens.total)} |`;
      }),
    ),
  ].join("\n");
  return `# ChronoRift v0.3.2 Luna formal benchmark results

- Execution: \`${report.executionId}\`
- Report hash: \`${report.reportHash}\`
- First-execution selection hash: \`${report.selectionHash}\`
- Status: **${report.status}**
- Gate: **${gate.status}**
- Frozen metric set: \`${report.suite.metricSet}\`
- Score eligibility: ${aggregate?.scoreEligibleCells ?? 0}/36 cells; infrastructure-unavailable cells remain unscored.

${rows}

## Fixture × arm breakdown

${breakdown}

This file is generated from \`${FORMAL_REPORT_FILENAME_V3}\`. Run \`corepack pnpm benchmark:verify -- --report <path> --spec <path>\` before interpreting it.
`;
};

export interface PublishFormalBenchmarkV3Options {
  readonly cwd: string;
  readonly artifactRoot: string;
  readonly specPath: string;
  readonly executionId: string;
  readonly outputDirectory: string;
  /** Test seam; the CLI never exposes a way to bypass checkout verification. */
  readonly verifyCheckout?:
    | ((
        suite: BenchmarkReportV3["suite"],
        report: BenchmarkReportV3,
        outputDirectory: string,
      ) => Promise<void>)
    | undefined;
}

export function assertPublicationOutputScopeV3(
  cwd: string,
  outputDirectory: string,
  porcelainStatus: string,
  suite: BenchmarkReportV3["suite"],
): void {
  const output = resolve(outputDirectory);
  const campaign = formalCampaignForSuiteV3(suite);
  const requiredOutput = resolve(cwd, campaign.evidenceDirectory);
  if (output !== requiredOutput) {
    throw new Error(
      `Formal V3 publication output must be ${campaign.evidenceDirectory}`,
    );
  }
  const allowed = new Set(
    [
      FORMAL_REPORT_FILENAME_V3,
      FORMAL_RESULTS_FILENAME_V3,
      FORMAL_CASE_FILENAME_V3,
    ].map((filename) =>
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
        "Publication requires a clean checkout except for its three generated V3 artifacts",
      );
    }
  }
}

async function verifyPublicationCheckout(
  cwd: string,
  suite: BenchmarkReportV3["suite"],
  report: BenchmarkReportV3,
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
    throw new Error("V3 publication checkout does not match frozen provenance");
  }
  assertPublicationOutputScopeV3(cwd, outputDirectory, status.stdout, suite);
}

export async function publishFormalBenchmarkV3(
  options: PublishFormalBenchmarkV3Options,
): Promise<readonly string[]> {
  const suite = parseFormalBenchmarkSuiteSpecV3(
    await readJson(options.specPath),
  );
  const executionId = asBenchmarkExecutionId(options.executionId);
  const repository = new V03BenchmarkJsonArtifactRepositoryV3(
    options.artifactRoot,
  );
  const report = await repository.getCompletedV3(
    suite.definitionId,
    executionId,
  );
  if (report === null) {
    throw new Error("Formal V3 benchmark execution is not sealed");
  }
  const verification = verifyBenchmarkReportV3(report);
  if (!verification.valid || !sameFormalSuiteV3(report.suite, suite)) {
    throw new Error("Formal V3 execution failed integrity verification");
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
      : await repository.getAttemptFinishedV3(
          suite.definitionId,
          executionId,
          cell.cellId,
          attempt.ordinal,
          attempt.attemptId,
        );
  if (
    cell !== undefined &&
    attempt !== undefined &&
    (finished === null ||
      canonicalJson(finished.attempt) !== canonicalJson(attempt) ||
      canonicalJson(finished.terminalCell) !== canonicalJson(cell))
  ) {
    throw new Error(
      "Formal V3 selected case does not resolve to its sealed attempt record",
    );
  }
  const raw = finished?.rawManifest ?? null;
  const caseBasis = JsonValueSchema.parse({
    schemaVersion: 3,
    reportHash: report.reportHash,
    selectionHash: report.selectionHash,
    suiteId: suite.suiteId,
    definitionId: suite.definitionId,
    executionId,
    provenance: report.provenance,
    caseStatus:
      cell === undefined || attempt === undefined ? "absent" : "present",
    cell: cell ?? null,
    attempt: attempt ?? null,
    // Explicit allowlist: Pi sessions, prompts, credentials, host paths, raw
    // provider payloads, source text, and model prose are never copied.
    evidence: sanitizeFormalCaseEvidence(raw as unknown as JsonValue),
  });
  assertPublicProjection(caseBasis);
  const caseBundle = BenchmarkPublishedCaseBundleV3Schema.parse({
    ...(caseBasis as Record<string, JsonValue>),
    caseHash: contentHash(caseBasis),
  });
  const output = await ensureOutputDirectory(options.outputDirectory);
  const files = [
    join(output, FORMAL_REPORT_FILENAME_V3),
    join(output, FORMAL_RESULTS_FILENAME_V3),
    join(output, FORMAL_CASE_FILENAME_V3),
  ] as const;
  await writeOnce(
    files[0],
    `${canonicalJson(report as unknown as JsonValue)}\n`,
  );
  await writeOnce(files[1], markdown(report));
  await writeOnce(
    files[2],
    `${canonicalJson(caseBundle as unknown as JsonValue)}\n`,
  );
  return files;
}
