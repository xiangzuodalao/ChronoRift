import type {
  AvailablePiModel,
  DeterministicPiHarnessOptions,
  ListAvailablePiModelsOptions,
  PersistPiApiKeyOptions,
  PersistPiApiKeyResult,
  PiDiagnosisRunResult,
  PiHarnessOptions,
} from "./types.js";

/** Run a real Pi SDK diagnostic loop. Pi is loaded lazily for offline callers. */
export async function runPiDiagnosis(
  options: PiHarnessOptions,
): Promise<PiDiagnosisRunResult> {
  const { runPiDiagnosisWithSdk } = await import("./internal/pi-runner.js");
  return runPiDiagnosisWithSdk(options);
}

/** Run the real Pi Session/Agent Loop with ChronoRift's offline faux model. */
export async function runDeterministicPiDiagnosis(
  options: DeterministicPiHarnessOptions,
): Promise<PiDiagnosisRunResult> {
  const { runDeterministicPiDiagnosisWithSdk } =
    await import("./internal/pi-runner.js");
  return runDeterministicPiDiagnosisWithSdk(options);
}

/** List models whose provider authentication is currently usable by Pi. */
export async function listAvailablePiModels(
  options: ListAvailablePiModelsOptions = {},
): Promise<readonly AvailablePiModel[]> {
  const { listAvailablePiModelsWithSdk } =
    await import("./internal/pi-runner.js");
  return listAvailablePiModelsWithSdk(options);
}

/** Persist an API key through Pi's user-level credential store. */
export async function persistPiApiKey(
  options: PersistPiApiKeyOptions,
): Promise<PersistPiApiKeyResult> {
  const { persistPiApiKeyWithSdk } = await import("./internal/pi-runner.js");
  return persistPiApiKeyWithSdk(options);
}
