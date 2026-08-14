import { createHash, randomBytes } from "node:crypto";

import { asSha256DigestV1 } from "@chronorift/domain";
import {
  connectGodotProjectEnvironmentRuntimeV2,
  type ProjectAdapterLaunchTargetV2,
  type LoadedProjectAdapterPackageV2,
} from "@chronorift/godot-adapter";
import type { GodotProjectEnvironmentObservationRecordV2 } from "@chronorift/godot-protocol";

import type { ManagedGodotProjectEnvironmentRuntimeCapabilityV2 } from "./managed-godot-project-environment-runtime-v2.js";
import type { SandboxExecutionResultV1 } from "./sandbox-broker.js";
import type {
  ProjectEnvironmentInstrumentedObservationV1,
  ProjectEnvironmentProcessObservationV1,
} from "./project-environment-conformance.js";
import type { GodotProjectEnvironmentSidecarPortV2 } from "./project-environment-sidecar-port-v2.js";
import { ProjectEnvironmentValidatedRingV2 } from "./project-environment-validated-ring-v2.js";

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
const MANAGED_HANDSHAKE_TIMEOUT_MS =
  LIMITS.importTimeoutMs + LIMITS.startupTimeoutMs;

export interface ProjectEnvironmentInstrumentedObservationV2 extends ProjectEnvironmentInstrumentedObservationV1 {
  readonly rawRecords: readonly GodotProjectEnvironmentObservationRecordV2[];
  readonly dynamicTraces: readonly {
    readonly traceId: string;
    readonly entityId: string;
    readonly firstIncarnation: number;
    readonly lastIncarnation: number;
    readonly recordSequences: readonly number[];
  }[];
}

export interface ProjectEnvironmentConformanceDriverV2 {
  runVanilla(
    target?: ProjectAdapterLaunchTargetV2,
  ): Promise<ProjectEnvironmentProcessObservationV1>;
  runBridgeOnly(
    target?: ProjectAdapterLaunchTargetV2,
  ): Promise<ProjectEnvironmentProcessObservationV1>;
  runInstrumented(
    loaded: LoadedProjectAdapterPackageV2,
    target?: ProjectAdapterLaunchTargetV2,
  ): Promise<ProjectEnvironmentInstrumentedObservationV2>;
}

export interface ProjectAdapterLaunchTargetConformanceRunV2 {
  readonly target: ProjectAdapterLaunchTargetV2;
  readonly vanilla: ProjectEnvironmentProcessObservationV1;
  readonly bridgeOnly: ProjectEnvironmentProcessObservationV1;
  readonly instrumented: ProjectEnvironmentInstrumentedObservationV2;
}

export const runProjectAdapterLaunchTargetConformanceV2 = async (
  loaded: LoadedProjectAdapterPackageV2,
  driver: ProjectEnvironmentConformanceDriverV2,
): Promise<readonly ProjectAdapterLaunchTargetConformanceRunV2[]> => {
  const runs: ProjectAdapterLaunchTargetConformanceRunV2[] = [];
  for (const target of loaded.launchTargetSelection.targetsToValidate) {
    const vanilla = await driver.runVanilla(target);
    const bridgeOnly = await driver.runBridgeOnly(target);
    const instrumented = await driver.runInstrumented(loaded, target);
    runs.push(Object.freeze({ target, vanilla, bridgeOnly, instrumented }));
  }
  return Object.freeze(runs);
};

export interface ProjectEnvironmentConformanceDriverOptionsV2 {
  readonly sidecar: GodotProjectEnvironmentSidecarPortV2;
  readonly managedRuntime: ManagedGodotProjectEnvironmentRuntimeCapabilityV2;
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

const sourceVerified = (
  records: readonly { readonly kind: string; readonly phase?: string }[],
  phase: string,
) =>
  records.some(
    (record) => record.kind === "source_verified" && record.phase === phase,
  );
const phaseSucceeded = (
  records: readonly { readonly kind: string; readonly outcome?: string }[],
  kind: string,
) =>
  records.some(
    (record) => record.kind === kind && record.outcome === "succeeded",
  );
const baseObservation = (
  result: {
    readonly sandbox: Extract<
      SandboxExecutionResultV1,
      { readonly kind: "executed" }
    >;
    readonly diagnostics: readonly {
      readonly kind: string;
      readonly phase?: string;
      readonly outcome?: string;
    }[];
  },
  stable: boolean,
  phase: string,
): ProjectEnvironmentProcessObservationV1 => {
  const receipt = result.sandbox.receipt;
  return {
    launched: true,
    importSucceeded:
      phase === "vanilla"
        ? result.diagnostics.some((record) => record.kind === "smoke_complete")
        : phaseSucceeded(result.diagnostics, "managed_import_result"),
    stableWindowObserved: stable,
    exitCode: receipt.exitCode,
    signal: receipt.signal,
    timedOut: receipt.status === "timed_out",
    stdoutSha256: receipt.stdout.sha256 ?? EMPTY_SHA256,
    stderrSha256: receipt.stderr.sha256 ?? EMPTY_SHA256,
    stdoutTruncated: receipt.stdout.truncated,
    stderrTruncated: receipt.stderr.truncated,
    elapsedMonotonicMs: Math.max(
      0,
      receipt.endedAtMonotonicMs - receipt.startedAtMonotonicMs,
    ),
    resourceUsage: {
      cpuUsageUsec: receipt.resourceUsage.cpuUsageUsec,
      memoryPeakBytes: receipt.resourceUsage.memoryPeakBytes,
      pidsPeak: receipt.resourceUsage.pidsPeak,
    },
    sourceIdentityReverified: sourceVerified(
      result.diagnostics,
      phase === "vanilla" ? "vanilla" : "managed",
    ),
    processTreeTerminated: receipt.cleanup.processGroupTerminated,
    isolationGroupEmpty: !receipt.cleanup.cgroupPopulated,
    scopeRemoved: receipt.cleanup.scopeRemoved,
    scratchRemoved: receipt.cleanup.scopeRemoved,
    storageReconciled: receipt.cleanup.storageReconciled === true,
  };
};

export const createProjectEnvironmentConformanceDriverV2 = (
  options: ProjectEnvironmentConformanceDriverOptionsV2,
): ProjectEnvironmentConformanceDriverV2 => {
  const common = (suffix: string, target?: ProjectAdapterLaunchTargetV2) => ({
    schemaVersion: 2 as const,
    runtimeProfile: "chronorift-managed-godot-project-environment-v2" as const,
    taskId: options.taskId,
    buildId: options.buildId,
    runtimeId: `runtime.v2.${suffix}${target === undefined ? "" : `.${target.targetId}`}`,
    executionId: `execution.v2.${suffix}${target === undefined ? "" : `.${target.targetId}`}`,
    managedRuntimeId: options.managedRuntime.managedRuntimeId,
    candidateSourceHash: options.candidateSourceHash,
    diagnosticFrameMaxBytes: LIMITS.diagnosticFrameMaxBytes,
    diagnosticTotalMaxBytes: LIMITS.diagnosticTotalMaxBytes,
    diagnosticMaxCount: LIMITS.diagnosticMaxCount,
    outputCaptureMaxBytes: LIMITS.outputCaptureMaxBytes,
  });
  const managed = async (
    mode: "bridge_only" | "instrumented",
    loaded?: LoadedProjectAdapterPackageV2,
    target?: ProjectAdapterLaunchTargetV2,
  ): Promise<
    | ProjectEnvironmentProcessObservationV1
    | ProjectEnvironmentInstrumentedObservationV2
  > => {
    const token = randomBytes(32).toString("hex");
    const launchScene =
      target !== undefined && target.scene !== options.expectedMainScene
        ? target.scene
        : undefined;
    const launch = {
      ...common(mode, target),
      operation: "managed_lifecycle" as const,
      protocolProfile: "chronorift-godot-project-environment-v2" as const,
      protocolVersion: 2 as const,
      token,
      overlayHash: options.managedRuntime.overlayHash,
      addonHash: options.managedRuntime.addonHash,
      expectedMainScene: options.expectedMainScene,
      ...(launchScene === undefined ? {} : { launchScene }),
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
    if (opened.kind !== "opened")
      throw new Error(`PE-B ${mode} sidecar did not open: ${opened.kind}`);
    let client;
    let ring: ProjectEnvironmentValidatedRingV2 | undefined;
    try {
      client = await connectGodotProjectEnvironmentRuntimeV2(
        opened.sidecar.transport,
        {
          schemaVersion: 2,
          token,
          expectedIdentity: {
            taskId: options.taskId,
            sourceClosureId: options.sourceClosureId,
            environmentRevisionId: options.environmentRevisionId,
            adapterRevisionId: options.adapterRevisionId,
            buildId: options.buildId,
            runtimeId: launch.runtimeId,
            executionId: launch.executionId,
            instrumentationMode: mode,
            candidateSourceHash: options.candidateSourceHash,
            adapterManifestSha256: options.adapterManifestSha256,
            sdkSha256: options.sdkSha256,
            bridgeSha256: options.bridgeSha256,
            toolchainSha256: options.toolchainSha256,
            observationProtocolVersion: 2,
            adapterSdkVersion: 2,
          },
          expectedEngineVersion: options.engineVersion,
          expectedPlatform: "Linux",
          expectedMainScene: options.expectedMainScene,
          expectedAdapterManifestSha256: options.adapterManifestSha256,
          observationWindowBatches: 8,
          // The managed sidecar performs the bounded first import before it
          // launches Godot and can emit the bridge hello.
          handshakeTimeoutMs: MANAGED_HANDSHAKE_TIMEOUT_MS,
        },
      );
      const realizedScene = target?.scene ?? options.expectedMainScene;
      if (client.ready.currentScene !== realizedScene)
        throw Object.assign(
          new Error(
            `target_not_realized: expected ${realizedScene} but Godot reported ${client.ready.currentScene ?? "no current scene"}`,
          ),
          { code: "target_not_realized" },
        );
      if (mode === "instrumented") {
        if (loaded === undefined)
          throw new Error(
            "PE-B instrumented conformance requires an adapter package",
          );
        await client.configureCapture({
          channels: [
            "entity",
            "state",
            "event",
            "runtime_error",
            "clock",
            "capture_loss",
          ],
          rollingRecordLimit: 4_096,
        });
        ring = new ProjectEnvironmentValidatedRingV2(
          loaded,
          launch.executionId,
        );
        ring.start(client);
        await ring.waitFor((records) => {
          try {
            return (
              ring?.dynamicTraces(loaded).length ===
                loaded.manifest.smoke.requiredDynamicTraces.length &&
              records.length > 0
            );
          } catch {
            return false;
          }
        }, loaded.manifest.smoke.timeoutMs);
      }
      await ring?.stop();
      await client.shutdown();
    } catch (error) {
      const diagnostics = opened.sidecar
        .diagnostics()
        .slice(-8)
        .map((entry) => JSON.stringify(entry))
        .join(" | ");
      await opened.sidecar.terminate().catch(() => undefined);
      await opened.sidecar.completion.catch(() => undefined);
      throw new Error(
        `PE-B ${mode} conformance failed: ${error instanceof Error ? error.message : String(error)}; diagnostics=${diagnostics || "none"}`,
        { cause: error },
      );
    } finally {
      await ring?.stop();
    }
    const completion = await opened.sidecar.completion;
    if (completion.kind !== "executed")
      throw new Error(`PE-B ${mode} sandbox was denied`);
    const result = {
      sandbox: completion,
      diagnostics: opened.sidecar.diagnostics(),
    };
    const base = baseObservation(result, true, "managed");
    if (mode === "bridge_only") return base;
    const loadedAdapter = loaded!;
    const rawRecords = ring!.snapshot();
    const traces = ring!.dynamicTraces(loadedAdapter);
    const entityRows = ring!.query("entities", 4_096);
    const states = ring!
      .query("state", 4_096)
      .filter((record) => record.kind === "state_sample");
    const eventRows = ring!.query("events", 4_096);
    if (
      entityRows.length === 0 ||
      states.length === 0 ||
      eventRows.length === 0
    ) {
      throw new Error(
        "PE-B conformance requires nonempty validated entity, state, and event queries",
      );
    }
    const runtimeErrors = rawRecords.filter(
      (
        record,
      ): record is Extract<typeof record, { readonly kind: "runtime_error" }> =>
        record.kind === "runtime_error",
    );
    return {
      ...base,
      bridgeHandshakeCount: 1,
      entityLifecycleRecords: entityRows.length,
      stateSamples: states.length,
      queries: 3,
      observedCustomEventTypeIds: Object.freeze(
        [
          ...new Set(
            eventRows
              .filter((record) => record.kind === "adapter_event")
              .map((record) => record.payload.eventTypeId),
          ),
        ].sort(),
      ),
      captures: 1,
      stateDomainIds: Object.freeze(
        [
          ...new Set(states.map((record) => record.payload.stateDomainId)),
        ].sort(),
      ),
      transportRecords: rawRecords.length,
      droppedRecords: 0,
      overwrittenRecords: 0,
      semanticCoverage: states.some(
        (record) => record.payload.semanticCoverage !== "declared",
      )
        ? "partial"
        : "declared",
      runtimeFailures: Object.freeze(
        runtimeErrors
          .filter((record) => record.payload.severity !== "warning")
          .map((record) => record.payload.message),
      ),
      bridgeExited: completion.receipt.cleanup.processGroupTerminated,
      rawRecords: Object.freeze(rawRecords),
      dynamicTraces: traces,
    };
  };
  return Object.freeze({
    runVanilla: async (target?: ProjectAdapterLaunchTargetV2) => {
      const launchScene =
        target !== undefined && target.scene !== options.expectedMainScene
          ? target.scene
          : undefined;
      const result = await options.sidecar.runVanilla({
        ...common("vanilla", target),
        operation: "vanilla_smoke",
        ...(launchScene === undefined ? {} : { launchScene }),
        importTimeoutMs: LIMITS.importTimeoutMs,
        vanillaTimeoutMs: 10_000,
        stabilityWindowMs: 2_000,
      });
      if (result.kind !== "completed")
        throw new Error("PE-B vanilla sandbox was denied");
      return baseObservation(result.result, true, "vanilla");
    },
    runBridgeOnly: (target?: ProjectAdapterLaunchTargetV2) =>
      managed(
        "bridge_only",
        undefined,
        target,
      ) as Promise<ProjectEnvironmentProcessObservationV1>,
    runInstrumented: (
      loaded: LoadedProjectAdapterPackageV2,
      target?: ProjectAdapterLaunchTargetV2,
    ) =>
      managed(
        "instrumented",
        loaded,
        target,
      ) as Promise<ProjectEnvironmentInstrumentedObservationV2>,
  });
};
