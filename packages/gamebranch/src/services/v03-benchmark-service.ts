import {
  BenchmarkCellResultV1Schema,
  BenchmarkReportV1Schema,
  asBenchmarkRunId,
  type BenchmarkCellResultV1,
  type BenchmarkReportV1,
} from "@chronorift/domain";

export interface BuildV03BenchmarkReportOptions {
  readonly benchmarkRunId: string;
  readonly suiteHash: string;
  readonly seed: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: string;
  readonly repetitions: number;
  readonly cells: readonly BenchmarkCellResultV1[];
}

const accuracy = (cells: readonly BenchmarkCellResultV1[]): number =>
  cells.length === 0
    ? 0
    : cells.filter((cell) => cell.mechanismCorrect).length / cells.length;

export function buildV03BenchmarkReport(
  options: BuildV03BenchmarkReportOptions,
): BenchmarkReportV1 {
  const cells = options.cells.map((cell) =>
    BenchmarkCellResultV1Schema.parse(cell),
  );
  const keys = cells.map(
    (cell) => `${cell.fixtureId}\0${cell.arm}\0${cell.repetition}`,
  );
  if (new Set(keys).size !== keys.length) {
    throw new Error(
      "Benchmark contains duplicate fixture/arm/repetition cells",
    );
  }
  if (
    cells.some(
      (cell) =>
        cell.benchmarkRunId !== options.benchmarkRunId ||
        cell.suiteHash !== options.suiteHash ||
        cell.provider !== options.provider ||
        cell.model !== options.model ||
        cell.thinkingLevel !== options.thinkingLevel ||
        cell.repetition > options.repetitions,
    )
  ) {
    throw new Error("Benchmark cell provenance does not match the report");
  }
  const fullAccuracy = accuracy(
    cells.filter((cell) => cell.arm === "chronorift-full"),
  );
  const genericAccuracy = accuracy(
    cells.filter((cell) => cell.arm === "generic"),
  );
  const delta = fullAccuracy - genericAccuracy;
  const incorrectConfirmations = cells.filter(
    (cell) => cell.incorrectConfirmation,
  ).length;
  return BenchmarkReportV1Schema.parse({
    schemaVersion: 1,
    benchmarkRunId: asBenchmarkRunId(options.benchmarkRunId),
    suiteHash: options.suiteHash,
    seed: options.seed,
    provider: options.provider,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    repetitions: options.repetitions,
    cells,
    advantage: {
      fullAccuracy,
      genericAccuracy,
      delta,
      incorrectConfirmations,
      thresholdMet:
        fullAccuracy >= 0.75 && incorrectConfirmations === 0 && delta >= 0.2,
    },
  });
}
