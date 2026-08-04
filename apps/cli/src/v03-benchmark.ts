import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  BenchmarkCellResultV1Schema,
  BenchmarkReportV1Schema,
  asBenchmarkRunId,
  asRunId,
  type BenchmarkArmV1,
  type BenchmarkCellResultV1,
  type BenchmarkReportV1,
  type JsonValue,
} from "@chronorift/domain";
import { buildV03BenchmarkReport } from "@chronorift/gamebranch";
import {
  V03_FIXTURE_IDS,
  type V03FixtureName,
  v03FixtureNameForId,
} from "@chronorift/godot-adapter";
import { canonicalJson, contentHash } from "@chronorift/json-artifacts";
import {
  runDeterministicV03PiDiagnosis,
  runV03PiDiagnosis,
  type PiThinkingLevel,
} from "@chronorift/pi-harness";

import { ChronoRiftV03AgentGameApi } from "./v03-agent-game-api.js";
import { createV03Run } from "./v03-runtime.js";
import { createV03NeutralSourceAccess } from "./v03-source-view.js";

const ARMS: readonly BenchmarkArmV1[] = [
  "generic",
  "evidence-only",
  "chronorift-full",
];
const DETERMINISTIC_PROVIDER = "chronorift-faux";
const DETERMINISTIC_MODEL = "chronorift-v0.3";
const SUITE_CONFIG_REVISION = "chronorift-v0.3-benchmark-config-1";
const SUITE_SOURCE_ROOTS = [
  "apps/cli/src",
  "packages/domain/src",
  "packages/gamebranch/src",
  "packages/godot-adapter/src",
  "packages/godot-protocol/src",
  "packages/json-artifacts/src",
  "packages/pi-harness/src",
  "godot/addons/chronorift",
  "fixtures/godot-switch-door",
  "fixtures/godot-frame-input-window",
  "fixtures/godot-physics-tunneling",
  "fixtures/godot-entity-reuse",
] as const;

interface BenchmarkCellSpec {
  readonly fixture: V03FixtureName;
  readonly arm: BenchmarkArmV1;
  readonly repetition: number;
}

export interface RunV03BenchmarkOptions {
  readonly cwd: string;
  readonly mode: "deterministic" | "live";
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly repetitions: number;
  readonly seed: string;
  readonly artifactRoot?: string | undefined;
  readonly godotBin?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly thinkingLevel?: PiThinkingLevel | undefined;
}

interface RawCellManifest {
  readonly schemaVersion: 1;
  readonly basis: JsonValue;
  readonly cell: BenchmarkCellResultV1;
}

const stableDigest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const benchmarkSuiteHash = async (cwd: string): Promise<string> => {
  const hash = createHash("sha256");
  hash.update(SUITE_CONFIG_REVISION);
  hash.update("\0");
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Benchmark suite source contains a symlink: ${path}`);
      }
      if (metadata.isDirectory()) await visit(path);
      else if (
        metadata.isFile() &&
        !path.endsWith(".test.ts") &&
        !path.endsWith(".live.test.ts") &&
        !path.endsWith(".godot.test.ts")
      ) {
        files.push(path);
      }
    }
  };
  for (const root of SUITE_SOURCE_ROOTS) await visit(resolve(cwd, root));
  for (const path of files.sort()) {
    hash.update(relative(cwd, path).split(sep).join("/"));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
};

const benchmarkId = (
  seed: string,
  provider: string,
  model: string,
  thinkingLevel: string,
  suiteHash: string,
  repetitions: number,
) =>
  asBenchmarkRunId(
    `benchmark:v03:${stableDigest(`${seed}\0${provider}\0${model}\0${thinkingLevel}\0${suiteHash}\0${repetitions}`).slice(0, 24)}`,
  );

const cellKey = (cell: BenchmarkCellSpec): string =>
  `${cell.fixture}--${cell.arm}--${cell.repetition}`;

const buildCells = (
  repetitions: number,
  seed: string,
): readonly BenchmarkCellSpec[] => {
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    throw new Error("Benchmark repetitions must be a positive integer");
  }
  const cells: BenchmarkCellSpec[] = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const fixture of V03_FIXTURE_IDS) {
      for (const arm of ARMS) cells.push({ fixture, arm, repetition });
    }
  }
  return cells.sort((left, right) =>
    stableDigest(`${seed}\0${cellKey(left)}`).localeCompare(
      stableDigest(`${seed}\0${cellKey(right)}`),
    ),
  );
};

const rawManifestPath = (
  artifactRoot: string,
  id: string,
  cell: BenchmarkCellSpec,
): string =>
  join(
    artifactRoot,
    "v0.3",
    "benchmarks",
    encodeURIComponent(id),
    "raw",
    `${cellKey(cell)}.json`,
  );

const isContained = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
};

const ensureRealDirectory = async (directory: string): Promise<void> => {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
    await mkdir(directory);
    metadata = await lstat(directory);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Unsafe benchmark artifact directory: ${directory}`);
  }
};

const assertSafeManifestPath = async (
  artifactRoot: string,
  path: string,
): Promise<void> => {
  const root = resolve(artifactRoot);
  if (!isContained(root, path)) {
    throw new Error("Benchmark manifest escapes the artifact root");
  }
  await mkdir(root, { recursive: true });
  const relativeParent = relative(root, dirname(path));
  let directory = root;
  await ensureRealDirectory(directory);
  for (const segment of relativeParent.split(sep).filter(Boolean)) {
    directory = join(directory, segment);
    await ensureRealDirectory(directory);
  }
  const canonicalRoot = await realpath(root);
  const canonicalParent = await realpath(dirname(path));
  if (!isContained(canonicalRoot, canonicalParent)) {
    throw new Error("Benchmark manifest parent resolves outside artifact root");
  }
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Unsafe benchmark manifest: ${path}`);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
};

const recordOf = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
};

const readRawCell = async (
  path: string,
): Promise<BenchmarkCellResultV1 | null> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const manifest = recordOf(
    JSON.parse(text) as unknown,
    "raw benchmark manifest",
  );
  if (manifest["schemaVersion"] !== 1) {
    throw new Error(`Unsupported raw benchmark manifest at ${path}`);
  }
  const cell = BenchmarkCellResultV1Schema.parse(manifest["cell"]);
  const basis = manifest["basis"] as JsonValue;
  if (contentHash(basis) !== cell.rawManifestHash) {
    throw new Error(`Raw benchmark manifest hash mismatch at ${path}`);
  }
  return cell;
};

const writeRawCell = async (
  path: string,
  basis: JsonValue,
  cell: BenchmarkCellResultV1,
): Promise<void> => {
  const manifest: RawCellManifest = { schemaVersion: 1, basis, cell };
  await writeFile(
    path,
    `${canonicalJson(manifest as unknown as JsonValue)}\n`,
    {
      encoding: "utf8",
      flag: "wx",
    },
  );
};

const sourceLocationCorrect = (
  proposal: {
    readonly suspectedSource?:
      | { readonly path: string; readonly symbol?: string | undefined }
      | undefined;
  },
  oracle: { readonly sourcePath: string; readonly sourceSymbol: string },
): boolean | null => {
  if (proposal.suspectedSource === undefined) return null;
  return (
    proposal.suspectedSource.path.replaceAll("\\", "/") === "case/main.gd" &&
    proposal.suspectedSource.symbol === oracle.sourceSymbol
  );
};

async function runCell(
  options: RunV03BenchmarkOptions,
  id: ReturnType<typeof asBenchmarkRunId>,
  provider: string,
  model: string,
  thinkingLevel: PiThinkingLevel,
  suiteHash: string,
  artifactRoot: string,
  spec: BenchmarkCellSpec,
): Promise<BenchmarkCellResultV1> {
  const manifestPath = rawManifestPath(artifactRoot, id, spec);
  await assertSafeManifestPath(artifactRoot, manifestPath);
  const resumed = await readRawCell(manifestPath);
  if (resumed !== null) {
    if (
      resumed.benchmarkRunId !== id ||
      resumed.fixtureId !== spec.fixture ||
      resumed.arm !== spec.arm ||
      resumed.repetition !== spec.repetition ||
      resumed.provider !== provider ||
      resumed.model !== model ||
      resumed.thinkingLevel !== thinkingLevel ||
      resumed.suiteHash !== suiteHash
    ) {
      throw new Error(
        `Raw benchmark cell provenance mismatch at ${manifestPath}`,
      );
    }
    return resumed;
  }

  const runId = asRunId(
    `run:v03:benchmark:${stableDigest(`${id}\0${cellKey(spec)}`).slice(0, 24)}`,
  );
  const context = await createV03Run({
    cwd: options.cwd,
    fixture: spec.fixture,
    artifactRoot,
    runId,
    ...(options.godotBin === undefined ? {} : { godotBin: options.godotBin }),
  });
  const game = new ChronoRiftV03AgentGameApi(context);
  const source = await createV03NeutralSourceAccess(context);
  const harnessOptions = {
    cwd: options.cwd,
    runDir: context.runDirectory,
    arm: spec.arm,
    initialCapsuleId: context.evidenceCapsule.capsuleId,
    baselineExecutionId: context.baselineExecution.executionId,
    game,
    source,
    failureBrief: context.failureBrief,
    thinkingLevel,
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  } as const;
  const diagnosis =
    options.mode === "deterministic"
      ? await runDeterministicV03PiDiagnosis(harnessOptions)
      : await runV03PiDiagnosis({ ...harnessOptions, provider, model });
  const verdict = await context.gameBranch.concludeV3(
    diagnosis.proposal,
    diagnosis.accessReceipts,
  );
  const expectedMechanism = context.preparedFixture.oracle.mechanismCode;
  const mechanismCorrect =
    diagnosis.proposal.mechanismCode === expectedMechanism;
  const basis = {
    schemaVersion: 1,
    benchmarkRunId: id,
    suiteHash,
    fixtureId: context.preparedFixture.oracle.fixtureId,
    arm: spec.arm,
    repetition: spec.repetition,
    runId: context.runId,
    proposal: diagnosis.proposal,
    accessReceipts: diagnosis.accessReceipts,
    verdict,
    piSession: diagnosis.piSession,
    gameExecutions: game.gameExecutions,
  } as unknown as JsonValue;
  const cell = BenchmarkCellResultV1Schema.parse({
    schemaVersion: 1,
    benchmarkRunId: id,
    suiteHash,
    fixtureId: context.preparedFixture.oracle.fixtureId,
    arm: spec.arm,
    repetition: spec.repetition,
    provider,
    model,
    thinkingLevel: diagnosis.piSession.thinkingLevel,
    expectedMechanism,
    proposedMechanism: diagnosis.proposal.mechanismCode,
    mechanismCorrect,
    verdict: verdict.status,
    incorrectConfirmation: verdict.status === "confirmed" && !mechanismCorrect,
    sourceLocationCorrect: sourceLocationCorrect(
      diagnosis.proposal,
      context.preparedFixture.oracle,
    ),
    gameExecutions: game.gameExecutions,
    toolCalls: diagnosis.piSession.stats.toolCalls,
    wallTimeMs: diagnosis.wallTimeMs,
    tokens: diagnosis.piSession.stats.tokens,
    rawManifestHash: contentHash(basis),
  });
  await writeRawCell(manifestPath, basis, cell);
  return cell;
}

export async function runV03Benchmark(
  options: RunV03BenchmarkOptions,
): Promise<BenchmarkReportV1> {
  const provider =
    options.mode === "deterministic"
      ? DETERMINISTIC_PROVIDER
      : (options.provider ?? "").trim();
  const model =
    options.mode === "deterministic"
      ? DETERMINISTIC_MODEL
      : (options.model ?? "").trim();
  if (provider.length === 0 || model.length === 0) {
    throw new Error("Live benchmark requires an explicit provider and model");
  }
  const artifactRoot = resolve(
    options.cwd,
    options.artifactRoot ?? ".chronorift",
  );
  const thinkingLevel =
    options.mode === "deterministic" ? "off" : (options.thinkingLevel ?? "low");
  const suiteHash = await benchmarkSuiteHash(options.cwd);
  const id = benchmarkId(
    options.seed,
    provider,
    model,
    thinkingLevel,
    suiteHash,
    options.repetitions,
  );
  const specs = buildCells(options.repetitions, options.seed);
  const cells: BenchmarkCellResultV1[] = [];
  for (const spec of specs) {
    cells.push(
      await runCell(
        options,
        id,
        provider,
        model,
        thinkingLevel,
        suiteHash,
        artifactRoot,
        spec,
      ),
    );
  }
  if (
    cells.length !==
    V03_FIXTURE_IDS.length * ARMS.length * options.repetitions
  ) {
    throw new Error("Benchmark matrix is incomplete");
  }
  return buildV03BenchmarkReport({
    benchmarkRunId: id,
    suiteHash,
    seed: options.seed,
    provider,
    model,
    thinkingLevel,
    repetitions: options.repetitions,
    cells,
  });
}

export async function writeSanitizedV03BenchmarkReport(
  outputPath: string,
  reportInput: BenchmarkReportV1,
): Promise<string> {
  const report = BenchmarkReportV1Schema.parse(reportInput);
  const path = resolve(outputPath);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(
    temporary,
    `${canonicalJson(report as unknown as JsonValue)}\n`,
    "utf8",
  );
  await rename(temporary, path);
  return path;
}

export async function verifySanitizedV03BenchmarkReport(
  inputPath: string,
): Promise<BenchmarkReportV1> {
  const report = BenchmarkReportV1Schema.parse(
    JSON.parse(await readFile(resolve(inputPath), "utf8")) as unknown,
  );
  const currentSuiteHash = await benchmarkSuiteHash(process.cwd());
  if (report.suiteHash !== currentSuiteHash) {
    throw new Error(
      `Benchmark report suite hash ${report.suiteHash} does not match current runtime ${currentSuiteHash}`,
    );
  }
  const expectedKeys = new Set(
    buildCells(report.repetitions, report.seed).map(cellKey),
  );
  const actualKeys = new Set(
    report.cells.map((cell) =>
      cellKey({
        fixture: v03FixtureNameForId(cell.fixtureId),
        arm: cell.arm,
        repetition: cell.repetition,
      }),
    ),
  );
  if (
    actualKeys.size !== expectedKeys.size ||
    [...expectedKeys].some((key) => !actualKeys.has(key))
  ) {
    throw new Error(
      "Benchmark report does not contain the complete v0.3 matrix",
    );
  }
  const rebuilt = buildV03BenchmarkReport({
    benchmarkRunId: report.benchmarkRunId,
    suiteHash: report.suiteHash,
    seed: report.seed,
    provider: report.provider,
    model: report.model,
    thinkingLevel: report.thinkingLevel,
    repetitions: report.repetitions,
    cells: report.cells,
  });
  if (
    canonicalJson(rebuilt as unknown as JsonValue) !==
    canonicalJson(report as unknown as JsonValue)
  ) {
    throw new Error("Benchmark report aggregates do not match its cells");
  }
  if (!report.advantage.thresholdMet) {
    throw new Error("ChronoRift v0.3 advantage threshold was not met");
  }
  return report;
}
