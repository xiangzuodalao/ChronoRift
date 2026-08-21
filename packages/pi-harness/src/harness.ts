import type {
  AssertPiModelCapabilitiesOptions,
  AvailablePiModel,
  DeterministicPiHarnessOptions,
  ListAvailablePiModelsOptions,
  PersistPiApiKeyOptions,
  PersistPiApiKeyResult,
  PiDiagnosisRunResult,
  PiHarnessOptions,
} from "./types.js";
import type {
  ScriptedV04PiHarnessOptions,
  V04PiDiagnosisRunResult,
  V04PiHarnessOptions,
} from "./v04-types.js";

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

/** Validate frozen model metadata and credentials before a formal provider call. */
export async function assertPiModelCapabilities(
  options: AssertPiModelCapabilitiesOptions,
): Promise<AvailablePiModel> {
  const { assertPiModelCapabilitiesWithSdk } =
    await import("./internal/pi-runner.js");
  return assertPiModelCapabilitiesWithSdk(options);
}

/** Persist an API key through Pi's user-level credential store. */
export async function persistPiApiKey(
  options: PersistPiApiKeyOptions,
): Promise<PersistPiApiKeyResult> {
  const { persistPiApiKeyWithSdk } = await import("./internal/pi-runner.js");
  return persistPiApiKeyWithSdk(options);
}

/** Run a real Pi Session/Agent Loop against the SDK-neutral v0.4 API. */
export async function runV04PiDiagnosis(
  options: V04PiHarnessOptions,
): Promise<V04PiDiagnosisRunResult> {
  const { runV04PiDiagnosisWithSdk } = await import("./internal/v04-runner.js");
  return runV04PiDiagnosisWithSdk(options);
}

/**
 * Run a real Pi Session/Agent Loop with a caller-authored, offline faux-model
 * script. ChronoRift executes the script but never infers its mechanism.
 */
export async function runScriptedV04PiDiagnosis(
  options: ScriptedV04PiHarnessOptions,
): Promise<V04PiDiagnosisRunResult> {
  const { runScriptedV04PiDiagnosisWithSdk } =
    await import("./internal/v04-runner.js");
  return runScriptedV04PiDiagnosisWithSdk(options);
}
