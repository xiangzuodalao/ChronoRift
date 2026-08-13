import { createHash, randomBytes } from "node:crypto";

import { asSha256DigestV1 } from "@chronorift/domain";
import {
  connectGodotProjectEnvironmentRuntimeV1,
  ProjectAdapterObservationExecutionValidatorV1,
  validateProjectAdapterQueryRowsV1,
  type LoadedProjectAdapterPackageV1,
} from "@chronorift/godot-adapter";
import { PROJECT_ADAPTER_REQUIRED_MODULES_V1 } from "@chronorift/godot-protocol";

import type {
  ProjectEnvironmentConformanceDriverV1,
  ProjectEnvironmentInstrumentedObservationV1,
  ProjectEnvironmentProcessObservationV1,
} from "./project-environment-conformance.js";
import type { ManagedGodotProjectEnvironmentRuntimeCapabilityV1 } from "./managed-godot-project-environment-runtime.js";
import type { GodotProjectEnvironmentSidecarPortV1 } from "./project-environment-sidecar-port.js";

const EMPTY_SHA256 = asSha256DigestV1(
  createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
);
const LIMITS = Object.freeze({
  diagnosticFrameMaxBytes: 64 * 1024,
  diagnosticTotalMaxBytes: 1024 * 1024,
  diagnosticMaxCount: 256,
  outputCaptureMaxBytes: 256 * 1024,
  importTimeoutMs: 120_000,
  startupTimeoutMs: 30_000,
  executionTimeoutMs: 120_000,
});

export interface ProjectEnvironmentConformanceDriverOptionsV1 {
  readonly sidecar: GodotProjectEnvironmentSidecarPortV1;
  readonly managedRuntime: ManagedGodotProjectEnvironmentRuntimeCapabilityV1;
  readonly taskId: string;
  readonly sourceClosureId: string;
  readonly environmentRevisionId: string;
  readonly adapterRevisionId: string;
  readonly buildId: string;
  readonly candidateSourceHash: string;
  readonly expectedMainScene: string;
  readonly adapterManifestSha256: string;
  readonly sdkSha256: string;
  readonly bridgeSha256: string;
  readonly toolchainSha256: string;
  readonly engineVersion: string;
}

const phaseSucceeded = (
  diagnostics: readonly { readonly kind: string; readonly outcome?: string }[],
  kind: string,
): boolean =>
  diagnostics.some(
    (record) => record.kind === kind && record.outcome === "succeeded",
  );

const sourceVerified = (
  diagnostics: readonly { readonly kind: string; readonly phase?: string }[],
  phase: string,
): boolean =>
  diagnostics.some(
    (record) => record.kind === "source_verified" && record.phase === phase,
  );

const boundedDiagnosticSummary = (
  diagnostics: readonly { readonly kind: string }[],
): string =>
  JSON.stringify(
    diagnostics.slice(-32).map((diagnostic) => {
      const record = diagnostic as unknown as Record<string, unknown>;
      return Object.fromEntries(
        ["kind", "phase", "outcome", "code", "exitCode", "signal"]
          .filter((key) =>
            ["string", "number", "boolean"].includes(typeof record[key]),
          )
          .map((key) => [key, record[key]]),
      );
    }),
  );

const cleanup = (
  receipt: Extract<
    Awaited<
      ReturnType<
        ProjectEnvironmentConformanceDriverOptionsV1["sidecar"]["runVanilla"]
      >
    >,
    { readonly kind: "completed" }
  >["result"]["sandbox"]["receipt"],
) => ({
  processTreeTerminated: receipt.cleanup.processGroupTerminated,
  isolationGroupEmpty: !receipt.cleanup.cgroupPopulated,
  scopeRemoved: receipt.cleanup.scopeRemoved,
  scratchRemoved: receipt.cleanup.scopeRemoved,
  storageReconciled: receipt.cleanup.storageReconciled === true,
});

const vanillaObservation = (
  result: Extract<
    Awaited<
      ReturnType<
        ProjectEnvironmentConformanceDriverOptionsV1["sidecar"]["runVanilla"]
      >
    >,
    { readonly kind: "completed" }
  >["result"],
): ProjectEnvironmentProcessObservationV1 => ({
  launched: true,
  importSucceeded: result.diagnostics.some(
    (record) => record.kind === "smoke_complete",
  ),
  stableWindowObserved: result.diagnostics.some(
    (record) => record.kind === "smoke_complete",
  ),
  exitCode: result.sandbox.receipt.exitCode,
  signal: result.sandbox.receipt.signal,
  timedOut: result.sandbox.receipt.status === "timed_out",
  stdoutSha256: result.sandbox.receipt.stdout.sha256,
  stderrSha256: result.sandbox.receipt.stderr.sha256,
  stdoutTruncated: result.sandbox.receipt.stdout.truncated,
  stderrTruncated: result.sandbox.receipt.stderr.truncated,
  elapsedMonotonicMs: Math.max(
    0,
    result.sandbox.receipt.endedAtMonotonicMs -
      result.sandbox.receipt.startedAtMonotonicMs,
  ),
  resourceUsage: {
    cpuUsageUsec: result.sandbox.receipt.resourceUsage.cpuUsageUsec,
    memoryPeakBytes: result.sandbox.receipt.resourceUsage.memoryPeakBytes,
    pidsPeak: result.sandbox.receipt.resourceUsage.pidsPeak,
  },
  sourceIdentityReverified: sourceVerified(result.diagnostics, "vanilla"),
  ...cleanup(result.sandbox.receipt),
});

export const createProjectEnvironmentConformanceDriverV1 = (
  options: ProjectEnvironmentConformanceDriverOptionsV1,
): ProjectEnvironmentConformanceDriverV1 => {
  const common = (suffix: string) => ({
    schemaVersion: 1 as const,
    runtimeProfile: "chronorift-managed-godot-project-environment-v1" as const,
    taskId: options.taskId,
    buildId: options.buildId,
    runtimeId: `runtime:${suffix}`,
    executionId: `execution:${suffix}`,
    managedRuntimeId: options.managedRuntime.managedRuntimeId,
    candidateSourceHash: options.candidateSourceHash,
    diagnosticFrameMaxBytes: LIMITS.diagnosticFrameMaxBytes,
    diagnosticTotalMaxBytes: LIMITS.diagnosticTotalMaxBytes,
    diagnosticMaxCount: LIMITS.diagnosticMaxCount,
    outputCaptureMaxBytes: LIMITS.outputCaptureMaxBytes,
  });

  const runManaged = async (
    mode: "bridge_only" | "instrumented",
    loaded?: LoadedProjectAdapterPackageV1,
  ): Promise<
    | ProjectEnvironmentProcessObservationV1
    | ProjectEnvironmentInstrumentedObservationV1
  > => {
    const token = randomBytes(32).toString("hex");
    const launch = {
      ...common(mode),
      operation: "managed_lifecycle" as const,
      protocolProfile: "chronorift-godot-project-environment-v1" as const,
      protocolVersion: 1 as const,
      token,
      overlayHash: options.managedRuntime.overlayHash,
      addonHash: options.managedRuntime.addonHash,
      expectedMainScene: options.expectedMainScene,
      instrumentationMode: mode,
      sourceClosureId: options.sourceClosureId,
      environmentRevisionId: options.environmentRevisionId,
      adapterRevisionId: options.adapterRevisionId,
      adapterManifestSha256: options.adapterManifestSha256,
      sdkSha256: options.sdkSha256,
      bridgeSha256: options.bridgeSha256,
      toolchainSha256: options.toolchainSha256,
      importTimeoutMs: LIMITS.importTimeoutMs,
      startupTimeoutMs: LIMITS.startupTimeoutMs,
      executionTimeoutMs: LIMITS.executionTimeoutMs,
    };
    const opened = await options.sidecar.openManaged(launch);
    if (opened.kind !== "opened") {
      throw new Error(`PE ${mode} sidecar did not open: ${opened.kind}`);
    }
    const expectedIdentity = {
      taskId: launch.taskId,
      sourceClosureId: launch.sourceClosureId,
      environmentRevisionId: launch.environmentRevisionId,
      adapterRevisionId: launch.adapterRevisionId,
      buildId: launch.buildId,
      runtimeId: launch.runtimeId,
      executionId: launch.executionId,
      instrumentationMode: mode,
      candidateSourceHash: launch.candidateSourceHash,
      adapterManifestSha256: launch.adapterManifestSha256,
      sdkSha256: launch.sdkSha256,
      bridgeSha256: launch.bridgeSha256,
      toolchainSha256: launch.toolchainSha256,
    } as const;
    let client;
    let handshakeCount = 0;
    let entityLifecycleRecords = 0;
    let stateSamples = 0;
    let queries = 0;
    let captures = 0;
    let transportRecords = 0;
    let reportedDroppedRecords = 0;
    let lossRecordDroppedRecords = 0;
    let overwrittenRecords = 0;
    let semanticCoverage: "declared" | "partial" | "unknown" = "declared";
    const stateDomainIds = new Set<string>();
    const customEventIds = new Set<string>();
    const runtimeFailures: string[] = [];
    const executionObservationValidator =
      mode === "instrumented"
        ? new ProjectAdapterObservationExecutionValidatorV1(
            loaded ??
              (() => {
                throw new Error(
                  "instrumented conformance requires a loaded ProjectAdapter",
                );
              })(),
          )
        : null;
    try {
      client = await connectGodotProjectEnvironmentRuntimeV1(
        opened.sidecar.transport,
        {
          schemaVersion: 1,
          token,
          expectedIdentity,
          expectedEngineVersion: options.engineVersion,
          expectedPlatform: "Linux",
          expectedMainScene: options.expectedMainScene,
          expectedAdapterManifestSha256: options.adapterManifestSha256,
          requiredModules:
            mode === "bridge_only"
              ? ["lifecycle", "clock", "runtime_error", "capture"]
              : PROJECT_ADAPTER_REQUIRED_MODULES_V1,
          observationWindowBatches: 8,
          handshakeTimeoutMs: LIMITS.startupTimeoutMs,
        },
      );
      handshakeCount = 1;
      await client.configureCapture({
        channels: ["entity", "state", "event", "runtime_error"],
        rollingRecordLimit: 4_096,
      });
      captures = 1;
      if (mode === "instrumented") {
        const requiredStates = new Set(
          loaded?.manifest.smoke.requiredStateDomainIds ?? [],
        );
        const requiredEvents = new Set(
          loaded?.manifest.smoke.requiredCustomEventTypeIds ?? [],
        );
        const deadline = performance.now() + 15_000;
        while (performance.now() < deadline) {
          const batch = await client.nextObservationBatch(2_000);
          transportRecords += batch.records.length;
          reportedDroppedRecords = Math.max(
            reportedDroppedRecords,
            batch.coverage.droppedRecordCount,
          );
          overwrittenRecords = Math.max(
            overwrittenRecords,
            batch.coverage.overwriteCount,
          );
          for (const inputRecord of batch.records) {
            const record = (
              executionObservationValidator ??
              (() => {
                throw new Error(
                  "instrumented conformance lost its observation validator",
                );
              })()
            ).validate(inputRecord);
            if (record.kind === "entity_lifecycle") entityLifecycleRecords += 1;
            if (record.kind === "state_sample") {
              stateSamples += 1;
              stateDomainIds.add(record.payload.stateDomainId);
              if (record.payload.semanticCoverage === "unknown") {
                semanticCoverage = "unknown";
              } else if (
                record.payload.semanticCoverage === "partial" &&
                semanticCoverage === "declared"
              ) {
                semanticCoverage = "partial";
              }
            }
            if (record.kind === "adapter_event") {
              customEventIds.add(record.payload.eventTypeId);
            }
            if (record.kind === "capture_loss") {
              lossRecordDroppedRecords += record.payload.droppedRecordCount;
            }
            if (
              record.kind === "runtime_error" &&
              record.payload.severity !== "warning"
            ) {
              runtimeFailures.push(record.payload.message);
            }
          }
          await client.acknowledgeObservationBatch(batch, 8);
          const statesReady = [...requiredStates].every((id) =>
            stateDomainIds.has(id),
          );
          const eventsReady = [...requiredEvents].every((id) =>
            customEventIds.has(id),
          );
          if (
            entityLifecycleRecords >=
              (loaded?.manifest.smoke.minimumEntityLifecycleRecords ?? 1) &&
            stateSamples >= (loaded?.manifest.smoke.minimumStateSamples ?? 1) &&
            statesReady &&
            eventsReady
          ) {
            break;
          }
        }
        const entityQuery = await client.query({
          queryKind: "entities",
          ids: [],
          limit: 1,
        });
        queries += 1;
        const validatedEntityRows = validateProjectAdapterQueryRowsV1(
          loaded ??
            (() => {
              throw new Error(
                "instrumented conformance requires a loaded ProjectAdapter",
              );
            })(),
          "entities",
          entityQuery.rows,
        );
        const stateQuery = await client.query({
          queryKind: "state",
          ids: [],
          limit: 1,
        });
        queries += 1;
        const validatedStateRows = validateProjectAdapterQueryRowsV1(
          loaded ??
            (() => {
              throw new Error(
                "instrumented conformance requires a loaded ProjectAdapter",
              );
            })(),
          "state",
          stateQuery.rows,
        );
        for (const row of validatedStateRows) {
          if (row.kind !== "state_sample") continue;
          if (row.payload.semanticCoverage === "unknown") {
            semanticCoverage = "unknown";
          } else if (
            row.payload.semanticCoverage === "partial" &&
            semanticCoverage === "declared"
          ) {
            semanticCoverage = "partial";
          }
        }
        if (
          validatedEntityRows.length === 0 ||
          validatedStateRows.length === 0
        ) {
          runtimeFailures.push(
            "instrumented Ready observations were not queryable through the bridge",
          );
        }
      }
      const status = await client.status();
      reportedDroppedRecords = Math.max(
        reportedDroppedRecords,
        status.coverage.droppedRecordCount,
      );
      overwrittenRecords = Math.max(
        overwrittenRecords,
        status.coverage.overwriteCount,
      );
      await client.shutdown();
    } catch (error) {
      await opened.sidecar.terminate().catch(() => undefined);
      const completion = await opened.sidecar.completion.catch(() => null);
      const diagnostics = opened.sidecar.diagnostics();
      const message = error instanceof Error ? error.message : String(error);
      const completionFact =
        completion?.kind === "executed"
          ? `${completion.receipt.status}/exit=${String(completion.receipt.exitCode)}/signal=${String(completion.receipt.signal)}`
          : (completion?.kind ?? "completion-unavailable");
      throw new Error(
        `${message}; managed ${mode} completion=${completionFact}; diagnostics=${boundedDiagnosticSummary(diagnostics)}`,
        { cause: error },
      );
    }
    const sandbox = await opened.sidecar.completion;
    if (sandbox.kind !== "executed") {
      throw new Error("PE managed sidecar ended with a denial");
    }
    const diagnostics = opened.sidecar.diagnostics();
    const base: ProjectEnvironmentProcessObservationV1 = {
      launched: true,
      importSucceeded: phaseSucceeded(diagnostics, "managed_import_result"),
      stableWindowObserved: handshakeCount === 1,
      exitCode: sandbox.receipt.exitCode,
      signal: sandbox.receipt.signal,
      timedOut: sandbox.receipt.status === "timed_out",
      stdoutSha256: sandbox.receipt.stdout.sha256 ?? EMPTY_SHA256,
      stderrSha256: sandbox.receipt.stderr.sha256 ?? EMPTY_SHA256,
      stdoutTruncated: sandbox.receipt.stdout.truncated,
      stderrTruncated: sandbox.receipt.stderr.truncated,
      elapsedMonotonicMs: Math.max(
        0,
        sandbox.receipt.endedAtMonotonicMs -
          sandbox.receipt.startedAtMonotonicMs,
      ),
      resourceUsage: {
        cpuUsageUsec: sandbox.receipt.resourceUsage.cpuUsageUsec,
        memoryPeakBytes: sandbox.receipt.resourceUsage.memoryPeakBytes,
        pidsPeak: sandbox.receipt.resourceUsage.pidsPeak,
      },
      sourceIdentityReverified: sourceVerified(diagnostics, "managed"),
      ...cleanup(sandbox.receipt),
    };
    if (mode === "bridge_only") return base;
    return {
      ...base,
      bridgeHandshakeCount: handshakeCount,
      entityLifecycleRecords,
      stateSamples,
      queries,
      observedCustomEventTypeIds: Object.freeze([...customEventIds].sort()),
      captures,
      stateDomainIds: Object.freeze([...stateDomainIds].sort()),
      transportRecords,
      droppedRecords: Math.max(
        reportedDroppedRecords,
        lossRecordDroppedRecords,
      ),
      overwrittenRecords,
      semanticCoverage,
      runtimeFailures: Object.freeze(runtimeFailures),
      bridgeExited: sandbox.receipt.cleanup.processGroupTerminated,
    };
  };

  return Object.freeze({
    runVanilla: async () => {
      const result = await options.sidecar.runVanilla({
        ...common("vanilla"),
        operation: "vanilla_smoke",
        importTimeoutMs: LIMITS.importTimeoutMs,
        vanillaTimeoutMs: 10_000,
        stabilityWindowMs: 2_000,
      });
      if (result.kind !== "completed") {
        throw new Error("PE vanilla smoke was denied");
      }
      return vanillaObservation(result.result);
    },
    runBridgeOnly: () =>
      runManaged(
        "bridge_only",
      ) as Promise<ProjectEnvironmentProcessObservationV1>,
    runInstrumented: (loaded: LoadedProjectAdapterPackageV1) =>
      runManaged(
        "instrumented",
        loaded,
      ) as Promise<ProjectEnvironmentInstrumentedObservationV1>,
  });
};
