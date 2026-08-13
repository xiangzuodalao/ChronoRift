import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1,
  validateProjectEnvironmentGameToolInputV1,
  type ProjectEnvironmentGameToolNameV1,
} from "@chronorift/agent-protocol";

import {
  JsonValueSchema,
  ProjectEnvironmentPinnedCaptureV2Schema,
  ProjectEnvironmentRuntimeObservationReceiptV2Schema,
  projectRuntimeCleanupCompleteV1,
  type JsonValue,
  type ProjectCapabilitySetV1,
  type ProjectEnvironmentPinnedCaptureV2,
  type ProjectEnvironmentRuntimeObservationReceiptV2,
  type ProjectRuntimeCleanupReceiptV1,
} from "@chronorift/domain";
import {
  connectGodotProjectEnvironmentRuntimeV2,
  type GodotProjectEnvironmentRuntimeClientV2,
  type LoadedProjectAdapterPackageV2,
} from "@chronorift/godot-adapter";
import {
  canonicalJson,
  projectEnvironmentPackageContentDigestV1,
} from "@chronorift/json-artifacts";

import type { ManagedGodotProjectEnvironmentRuntimeCapabilityV2 } from "./managed-godot-project-environment-runtime-v2.js";
import type {
  GodotProjectEnvironmentSidecarPortV2,
  SandboxedGodotProjectEnvironmentSidecarV2,
} from "./project-environment-sidecar-port-v2.js";
import { ProjectEnvironmentValidatedRingV2 } from "./project-environment-validated-ring-v2.js";
import { projectEnvironmentRuntimeStopMissingEvidenceV2 } from "./project-environment-runtime-stop-readiness-v2.js";
import type {
  ProjectEnvironmentGameToolPort,
  ProjectEnvironmentGameToolPortRequestV1,
} from "@chronorift/pi-harness";

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const nowClock = (value: {
  readonly processFrame: number;
  readonly physicsTick: number;
  readonly simulationTimeUs: number;
  readonly renderFrame: number | null;
}) => ({
  schemaVersion: 1 as const,
  ...value,
  hostMonotonicUs: Math.max(0, Math.round(performance.now() * 1_000)),
});
const coverage = (observed: number) => ({
  schemaVersion: 1 as const,
  channelId: "project_adapter_observations_v2",
  status: "complete" as const,
  observedRecords: observed,
  droppedRecords: 0,
  overwrittenRecords: 0,
  limitations: [] as string[],
});

export interface ProjectEnvironmentRuntimeBuildV2 {
  readonly schemaVersion: 1;
  readonly buildId: string;
  readonly sourceClosureId: string;
  readonly candidateSourceHash: string;
  readonly expectedMainScene: string;
}

interface ActiveV2 {
  readonly runtimeId: string;
  readonly executionId: string;
  readonly observationReceiptId: string;
  readonly launchTargetId: string;
  readonly build: ProjectEnvironmentRuntimeBuildV2;
  readonly client: GodotProjectEnvironmentRuntimeClientV2;
  readonly sidecar: SandboxedGodotProjectEnvironmentSidecarV2;
  readonly ring: ProjectEnvironmentValidatedRingV2;
  readonly startedAt: string;
  captureWindowIds: string[];
  entityQueryCount: number;
  entityRows: number;
  stateQueryCount: number;
  stateRows: number;
  eventQueryCount: number;
  eventRows: number;
  phase: "running" | "stopped" | "poisoned";
}

/**
 * PE-B runtime authority. It deliberately exposes the existing 16 tool names
 * through one generic invoke entry while keeping all V2 observation reads in
 * the continuously validated Host ring.
 */
export class ProjectEnvironmentGameRuntimeV2 implements ProjectEnvironmentGameToolPort {
  #active: ActiveV2 | null = null;
  #operation = Promise.resolve();
  #lastDynamicTraces: readonly ProjectEnvironmentPinnedCaptureV2["dynamicTraces"][number][] =
    [];
  public get lastDynamicTraces(): readonly ProjectEnvironmentPinnedCaptureV2["dynamicTraces"][number][] {
    return this.#lastDynamicTraces;
  }
  public constructor(
    private readonly options: {
      readonly taskId: string;
      readonly environmentRevisionId: string;
      readonly adapterRevisionId: string;
      readonly adapterPackage: LoadedProjectAdapterPackageV2;
      readonly capabilitySet: ProjectCapabilitySetV1;
      readonly managedRuntime: ManagedGodotProjectEnvironmentRuntimeCapabilityV2;
      readonly sidecar: GodotProjectEnvironmentSidecarPortV2;
      readonly adapterManifestSha256: string;
      readonly sdkSha256: string;
      readonly bridgeSha256: string;
      readonly toolchainSha256: string;
      readonly engineVersion: string;
      readonly resolveBuild: () => Promise<ProjectEnvironmentRuntimeBuildV2>;
      readonly persistPinnedCapture: (
        capture: ProjectEnvironmentPinnedCaptureV2,
        records: readonly JsonValue[],
      ) => Promise<void>;
      readonly persistRuntimeObservation: (
        receipt: ProjectEnvironmentRuntimeObservationReceiptV2,
      ) => Promise<void>;
      readonly now?: (() => string) | undefined;
      readonly connect?:
        typeof connectGodotProjectEnvironmentRuntimeV2 | undefined;
    },
  ) {}

  public invoke(
    request: ProjectEnvironmentGameToolPortRequestV1,
  ): Promise<unknown> {
    if (
      !validateProjectEnvironmentGameToolInputV1(
        request.toolName,
        request.input,
      )
    )
      return Promise.resolve({
        schemaVersion: 1,
        toolCallId: request.toolCallId,
        outcome: "error",
        error: {
          code: "invalid_request",
          message: `Invalid ${request.toolName} input`,
          recoverable: false,
        },
      });
    if (
      (request.input as { readonly taskId: string }).taskId !==
      this.options.taskId
    )
      return Promise.resolve({
        schemaVersion: 1,
        toolCallId: request.toolCallId,
        outcome: "error",
        error: {
          code: "resource_task_mismatch",
          message: "The requested resource does not belong to this Task",
          recoverable: false,
        },
      });
    const run = this.#operation.then(() => this.invokeSerialized(request));
    this.#operation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  public async close(): Promise<void> {
    if (this.#active?.phase === "running") await this.finalize(this.#active);
  }

  private async invokeSerialized(
    request: ProjectEnvironmentGameToolPortRequestV1,
  ): Promise<unknown> {
    try {
      const input = request.input as Record<string, unknown>;
      const output =
        request.toolName === "game_launch"
          ? await this.launch(input)
          : request.toolName === "game_status"
            ? this.status(input)
            : request.toolName === "game_stop"
              ? await this.stop(input)
              : request.toolName === "game_query"
                ? await this.query(input)
                : request.toolName === "game_capture_configure"
                  ? await this.configure(input)
                  : request.toolName === "game_capture_pin"
                    ? await this.pin(input)
                    : request.toolName === "game_capabilities"
                      ? await this.capabilities()
                      : (() => {
                          throw new Error(
                            `unsupported_capability: ${request.toolName} is outside PE-B`,
                          );
                        })();
      return {
        schemaVersion: 1,
        toolCallId: request.toolCallId,
        outcome: "success",
        output,
      };
    } catch (error) {
      return {
        schemaVersion: 1,
        toolCallId: request.toolCallId,
        outcome: "error",
        error: {
          code:
            error instanceof Error &&
            /unsupported_capability/u.test(error.message)
              ? "unsupported_capability"
              : "operation_failed",
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
        },
      };
    }
  }

  private async capabilities() {
    const build = await this.options.resolveBuild();
    const available = new Set<ProjectEnvironmentGameToolNameV1>([
      "game_capabilities",
      "game_launch",
      "game_status",
      "game_stop",
      "game_query",
      "game_capture_configure",
      ...(this.options.persistPinnedCapture === undefined
        ? []
        : ["game_capture_pin" as const]),
    ]);
    return {
      schemaVersion: 1,
      taskId: this.options.taskId,
      environmentRevisionId: this.options.environmentRevisionId,
      adapterRevisionId: this.options.adapterRevisionId,
      buildId: build.buildId,
      runtimeId: this.#active?.runtimeId ?? null,
      modules: this.options.capabilitySet.modules,
      tools: PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1.map((tool) => ({
        schemaVersion: 1,
        toolName: tool.name,
        module: tool.availabilityModule,
        status: available.has(tool.name)
          ? "available"
          : "unsupported_capability",
        limitations: available.has(tool.name)
          ? []
          : ["This operation is outside PE-B dynamic projection."],
      })),
      limitations: [
        "PE-B retains one V2 instrumented runtime at a time.",
        "Query and pin read only the continuously validated Host ring.",
      ],
    };
  }

  private async launch(input: Record<string, unknown>) {
    if (this.#active !== null && this.#active.phase === "running")
      throw new Error("busy: one V2 runtime is already active");
    const build = await this.options.resolveBuild();
    if (input.buildId !== build.buildId)
      throw new Error("requested Build is not the current Task binding");
    const target = this.options.adapterPackage.manifest.launchTargets.find(
      (value) => value.targetId === input.launchTargetId,
    );
    if (target === undefined) throw new Error("unknown launch target");
    const runtimeId = `runtime.v2.${randomUUID()}`;
    const executionId = `execution.v2.${randomUUID()}`;
    const token = randomBytes(32).toString("hex");
    const startedAt = this.now();
    const opened = await this.options.sidecar.openManaged({
      schemaVersion: 2,
      runtimeProfile: "chronorift-managed-godot-project-environment-v2",
      operation: "managed_lifecycle",
      taskId: this.options.taskId,
      buildId: build.buildId,
      runtimeId,
      executionId,
      managedRuntimeId: this.options.managedRuntime.managedRuntimeId,
      candidateSourceHash: build.candidateSourceHash,
      diagnosticFrameMaxBytes: 64 * 1024,
      diagnosticTotalMaxBytes: 1024 * 1024,
      diagnosticMaxCount: 256,
      outputCaptureMaxBytes: 256 * 1024,
      protocolProfile: "chronorift-godot-project-environment-v2",
      protocolVersion: 2,
      token,
      overlayHash: this.options.managedRuntime.overlayHash,
      addonHash: this.options.managedRuntime.addonHash,
      expectedMainScene: build.expectedMainScene,
      instrumentationMode: "instrumented",
      sourceClosureId: build.sourceClosureId,
      environmentRevisionId: this.options.environmentRevisionId,
      adapterRevisionId: this.options.adapterRevisionId,
      adapterManifestSha256: this.options.adapterManifestSha256,
      sdkSha256: this.options.sdkSha256,
      bridgeSha256: this.options.bridgeSha256,
      toolchainSha256: this.options.toolchainSha256,
      importTimeoutMs: 120_000,
      startupTimeoutMs: 30_000,
      executionTimeoutMs: 600_000,
    });
    if (opened.kind !== "opened")
      throw new Error(`V2 runtime did not open: ${opened.kind}`);
    let client: GodotProjectEnvironmentRuntimeClientV2;
    try {
      client = await (
        this.options.connect ?? connectGodotProjectEnvironmentRuntimeV2
      )(opened.sidecar.transport, {
        schemaVersion: 2,
        token,
        expectedIdentity: {
          taskId: this.options.taskId,
          sourceClosureId: build.sourceClosureId,
          environmentRevisionId: this.options.environmentRevisionId,
          adapterRevisionId: this.options.adapterRevisionId,
          buildId: build.buildId,
          runtimeId,
          executionId,
          instrumentationMode: "instrumented",
          candidateSourceHash: build.candidateSourceHash,
          adapterManifestSha256: this.options.adapterManifestSha256,
          sdkSha256: this.options.sdkSha256,
          bridgeSha256: this.options.bridgeSha256,
          toolchainSha256: this.options.toolchainSha256,
          observationProtocolVersion: 2,
          adapterSdkVersion: 2,
        },
        expectedEngineVersion: this.options.engineVersion,
        expectedPlatform: "Linux",
        expectedMainScene: build.expectedMainScene,
        expectedAdapterManifestSha256: this.options.adapterManifestSha256,
        observationWindowBatches: 8,
        handshakeTimeoutMs: 30_000,
      });
    } catch (error) {
      await opened.sidecar.terminate().catch(() => undefined);
      await opened.sidecar.completion.catch(() => undefined);
      throw error;
    }
    const ring = new ProjectEnvironmentValidatedRingV2(
      this.options.adapterPackage,
      executionId,
      4_096,
      async () => {
        await opened.sidecar.terminate().catch(() => undefined);
      },
    );
    ring.start(client);
    this.#active = {
      runtimeId,
      executionId,
      observationReceiptId: `runtime-observation-receipt.v2.${randomUUID()}`,
      launchTargetId: target.targetId,
      build,
      client,
      sidecar: opened.sidecar,
      ring,
      startedAt,
      captureWindowIds: [],
      entityQueryCount: 0,
      entityRows: 0,
      stateQueryCount: 0,
      stateRows: 0,
      eventQueryCount: 0,
      eventRows: 0,
      phase: "running",
    };
    return {
      schemaVersion: 1,
      taskId: this.options.taskId,
      runtimeId,
      executionId,
      buildId: build.buildId,
      environmentRevisionId: this.options.environmentRevisionId,
      adapterRevisionId: this.options.adapterRevisionId,
      launchReceiptId: `launch-receipt.v2.${randomUUID()}`,
      requested: {
        launchTargetId: input.launchTargetId,
        parameters: input.parameters ?? {},
      },
      realized: {
        launchTargetId: target.targetId,
        parameters: {},
        renderer: client.fingerprint.renderer,
        clock: nowClock(client.ready.clock),
      },
      status: "running",
      modules: this.options.capabilitySet.modules,
      limitations: [],
    };
  }

  private status(input: Record<string, unknown>) {
    const active = this.requireRuntime(input.runtimeId);
    return {
      schemaVersion: 1,
      taskId: this.options.taskId,
      runtimeId: active.runtimeId,
      executionId: active.executionId,
      buildId: active.build.buildId,
      status: active.phase === "poisoned" ? "crashed" : active.phase,
      clock: nowClock(active.client.ready.clock),
      modules: this.options.capabilitySet.modules,
      coverage: [coverage(active.ring.validatedRecordCount)],
      loss: [],
      limitations: active.ring.poisoned
        ? ["Execution observation lineage is poisoned."]
        : [],
    };
  }

  private async query(input: Record<string, unknown>) {
    const active = this.requireExecution(input.executionId);
    if (input.cursor !== undefined || input.filters !== undefined)
      throw new Error(
        "unsupported_capability: V2 query filters/cursors are not implemented",
      );
    const select = String(input.select);
    if (
      !(["entities", "state", "events", "runtime_errors"] as const).includes(
        select as never,
      )
    )
      throw new Error(
        "unsupported_capability: query projection is not implemented",
      );
    const kind =
      select === "runtime_errors"
        ? "errors"
        : (select as "entities" | "state" | "events");
    if (kind !== "errors") {
      await active.ring.waitFor(() => {
        try {
          return (
            active.ring.dynamicTraces(this.options.adapterPackage).length > 0
          );
        } catch {
          return false;
        }
      }, 30_000);
    }
    const rows = active.ring.query(kind, Number(input.limit ?? 100));
    if (kind === "entities") {
      active.entityQueryCount += 1;
      active.entityRows += rows.length;
    }
    if (kind === "state") {
      active.stateQueryCount += 1;
      active.stateRows += rows.length;
    }
    if (kind === "events") {
      active.eventQueryCount += 1;
      active.eventRows += rows.length;
    }
    const rowKind = {
      entity_lifecycle: "entity",
      state_sample: "state",
      adapter_event: "event",
      runtime_error: "runtime_error",
      clock: "clock",
      capture_loss: "coverage",
    } as const;
    return {
      schemaVersion: 1,
      taskId: this.options.taskId,
      executionId: active.executionId,
      rows: rows.map((value, index) => ({
        schemaVersion: 1,
        rowId: `query-row.v2.${digest([active.executionId, index, value])}`,
        kind: rowKind[value.kind],
        clock: nowClock(value.clock),
        value,
      })),
      nextCursor: null,
      coverage: [coverage(active.ring.validatedRecordCount)],
      loss: [],
      limitations: [],
    };
  }

  private async configure(input: Record<string, unknown>) {
    const active = this.requireRuntime(input.runtimeId);
    const profile = input.profile as Record<string, unknown>;
    const expectedProfile = {
      channels: ["entity", "state", "event", "runtime_error"],
      retention: { clockDomain: "process_frame", before: 0, after: 0 },
      sampling: [],
      triggers: [],
    };
    if (JSON.stringify(profile) !== JSON.stringify(expectedProfile))
      throw new Error(
        "unsupported_capability: PE-B capture requires the exact current lossless profile",
      );
    const configured = await active.client.configureCapture({
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
    return {
      schemaVersion: 1,
      taskId: this.options.taskId,
      runtimeId: active.runtimeId,
      captureProfileId: `capture-profile.v2.${digest(profile)}`,
      status: "configured",
      realized: {
        channels: configured.channels,
        rollingRecordLimit: configured.realizedRollingRecordLimit,
        retention: { clockDomain: "process_frame", before: 0, after: 0 },
        sampling: [],
        triggers: [],
      },
      coverage: [coverage(active.ring.validatedRecordCount)],
      loss: [],
      limitations: [],
    };
  }

  private async pin(input: Record<string, unknown>) {
    const active = this.requireRuntime(input.runtimeId);
    if (
      JSON.stringify(input.anchor) !== JSON.stringify({ kind: "now" }) ||
      input.before !== 0 ||
      input.after !== 0
    )
      throw new Error(
        "unsupported_capability: PE-B pins only the current lossless validated ring",
      );
    await active.ring.waitFor((records) => records.length >= 9, 30_000);
    const records = active.ring.snapshot();
    const traces = active.ring
      .dynamicTraces(this.options.adapterPackage)
      .map((trace) => ({
        schemaVersion: 2 as const,
        ...trace,
        recordSequences: [...trace.recordSequences],
      }));
    const jsonRecords = records.map((record) => JsonValueSchema.parse(record));
    const bytes = Buffer.from(`${canonicalJson(jsonRecords)}\n`, "utf8");
    const captureWindowId = `capture-window.v2.${randomUUID()}`;
    const capture = ProjectEnvironmentPinnedCaptureV2Schema.parse({
      schemaVersion: 2,
      observationProtocolVersion: 2,
      recordsSchemaVersion: 2,
      captureWindowId,
      taskId: this.options.taskId,
      runtimeId: active.runtimeId,
      executionId: active.executionId,
      buildId: active.build.buildId,
      environmentRevisionId: this.options.environmentRevisionId,
      adapterRevisionId: this.options.adapterRevisionId,
      recordCount: jsonRecords.length,
      contentDigest: projectEnvironmentPackageContentDigestV1([
        { path: "records.json", bytes },
      ]),
      anchorClock: nowClock(records.at(-1)!.clock),
      coverage: [coverage(records.length)],
      loss: [],
      dynamicTraces: traces,
      createdAt: this.now(),
    });
    // Retention precedes success. A failure leaves ring data available to retry.
    await this.options.persistPinnedCapture(capture, jsonRecords);
    active.captureWindowIds.push(captureWindowId);
    return {
      schemaVersion: 1,
      taskId: this.options.taskId,
      runtimeId: active.runtimeId,
      captureWindowId,
      anchor: {
        requested: input.anchor,
        realized: capture.anchorClock,
        quantized: true,
      },
      coverage: capture.coverage,
      loss: [],
      limitations: [
        `Validated V2 dynamic traces: ${traces.map((trace) => trace.traceId).join(", ")}`,
      ],
    };
  }

  private async stop(input: Record<string, unknown>) {
    const active = this.requireRuntime(input.runtimeId);
    let dynamicTraceCount = 0;
    try {
      dynamicTraceCount = active.ring.dynamicTraces(
        this.options.adapterPackage,
      ).length;
    } catch {
      // The exact recognizer failure is retained by authoritative finalization;
      // stop remains recoverable while the execution is still running.
    }
    const missing = projectEnvironmentRuntimeStopMissingEvidenceV2({
      dynamicTraceCount,
      entityRows: active.entityRows,
      stateRows: active.stateRows,
      eventRows: active.eventRows,
      captureWindowCount: active.captureWindowIds.length,
    });
    if (missing.length > 0)
      throw new Error(
        `runtime evidence is incomplete; keep this runtime running and add: ${missing.join(", ")}`,
      );
    return this.finalize(active);
  }
  private async finalize(active: ActiveV2) {
    if (active.phase !== "running") throw new Error("runtime is not running");
    let failure: string | null = null;
    await active.ring.stop();
    try {
      await active.client.shutdown();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      await active.sidecar.terminate().catch(() => undefined);
    }
    const completed = await active.sidecar.completion;
    const receipt = completed.kind === "executed" ? completed.receipt : null;
    const cleanup: ProjectRuntimeCleanupReceiptV1 = {
      schemaVersion: 1,
      processTreeTerminated: receipt?.cleanup.processGroupTerminated ?? false,
      runtimeExited: receipt?.status === "succeeded",
      bridgeExited: receipt?.status === "succeeded",
      isolationGroupEmpty: !(receipt?.cleanup.cgroupPopulated ?? true),
      scopeRemoved: receipt?.cleanup.scopeRemoved ?? false,
      scratchRemoved: receipt?.cleanup.scopeRemoved ?? false,
      storageReconciled: receipt?.cleanup.storageReconciled === true,
    };
    let traces: ReturnType<ActiveV2["ring"]["dynamicTraces"]> = [];
    try {
      traces = active.ring.dynamicTraces(this.options.adapterPackage);
    } catch (error) {
      failure ??= error instanceof Error ? error.message : String(error);
    }
    this.#lastDynamicTraces = Object.freeze(
      traces.map((trace) =>
        Object.freeze({
          schemaVersion: 2 as const,
          ...trace,
          recordSequences: [...trace.recordSequences],
        }),
      ),
    );
    const failures = [
      ...(failure === null ? [] : [failure]),
      ...(active.ring.poisoned
        ? ["V2 observation lineage was sticky-poisoned."]
        : []),
      ...(!projectRuntimeCleanupCompleteV1(cleanup)
        ? ["V2 sandbox cleanup was incomplete."]
        : []),
    ];
    const succeeded =
      failures.length === 0 &&
      active.captureWindowIds.length > 0 &&
      active.entityRows > 0 &&
      active.stateRows > 0 &&
      active.eventRows > 0 &&
      traces.length > 0;
    const observedAt = this.now();
    const observation =
      ProjectEnvironmentRuntimeObservationReceiptV2Schema.parse({
        schemaVersion: 2,
        observationProtocolVersion: 2,
        adapterSdkVersion: 2,
        receiptId: active.observationReceiptId,
        taskId: this.options.taskId,
        runtimeId: active.runtimeId,
        executionId: active.executionId,
        buildId: active.build.buildId,
        environmentRevisionId: this.options.environmentRevisionId,
        adapterRevisionId: this.options.adapterRevisionId,
        launchTargetId: active.launchTargetId,
        instrumentationMode: "instrumented",
        status: "stopped",
        bridgeHandshakeCount: 1,
        clock: nowClock(active.client.ready.clock),
        queryObservations: {
          schemaVersion: 1,
          entityQueryCount: active.entityQueryCount,
          entityRows: active.entityRows,
          stateQueryCount: active.stateQueryCount,
          stateRows: active.stateRows,
        },
        eventQueryCount: active.eventQueryCount,
        eventRows: active.eventRows,
        captureCount: active.captureWindowIds.length,
        captureWindowIds: active.captureWindowIds,
        coverage: [coverage(active.ring.validatedRecordCount)],
        loss: [],
        cleanup,
        outcome: succeeded ? "succeeded" : "incomplete",
        failures,
        startedAt: active.startedAt,
        observedAt,
        completedAt: this.now(),
        validatedRecordCount: active.ring.validatedRecordCount,
        stickyPoisoned: active.ring.poisoned,
        dynamicTraces: this.#lastDynamicTraces,
      });
    await this.options.persistRuntimeObservation(observation);
    active.phase = succeeded ? "stopped" : "poisoned";
    return {
      schemaVersion: 1,
      taskId: this.options.taskId,
      runtimeId: active.runtimeId,
      executionId: active.executionId,
      status: "stopped",
      cleanup,
      coverage: observation.coverage,
      loss: observation.loss,
      limitations: failures,
    };
  }

  private requireRuntime(value: unknown): ActiveV2 {
    if (this.#active === null || this.#active.runtimeId !== value)
      throw new Error("runtime_not_found");
    return this.#active;
  }
  private requireExecution(value: unknown): ActiveV2 {
    if (this.#active === null || this.#active.executionId !== value)
      throw new Error("execution_not_found");
    return this.#active;
  }
  private now(): string {
    return (this.options.now ?? (() => new Date().toISOString()))();
  }
}
