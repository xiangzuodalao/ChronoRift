import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1,
  validateProjectEnvironmentGameToolInputV1,
  type ProjectEnvironmentGameCaptureConfigureInputV1,
  type ProjectEnvironmentGameCapturePinInputV1,
  type ProjectEnvironmentGameCheckpointCreateInputV1,
  type ProjectEnvironmentGameCheckpointRestoreInputV1,
  type ProjectEnvironmentGameInputInputV1,
  type ProjectEnvironmentGameLaunchInputV1,
  type ProjectEnvironmentGameQueryInputV1,
  type ProjectEnvironmentGameSetControlsInputV1,
  type ProjectEnvironmentGameStatusInputV1,
  type ProjectEnvironmentGameStepInputV1,
  type ProjectEnvironmentGameToolNameV1,
} from "@chronorift/agent-protocol";
import {
  JsonValueSchema,
  ProjectEnvironmentPinnedCaptureV1Schema,
  ProjectEnvironmentRuntimeObservationReceiptV1Schema,
  projectRuntimeCleanupCompleteV1,
  type JsonValue,
  type ProjectCapabilitySetV1,
  type ProjectEnvironmentPinnedCaptureV1,
  type ProjectEnvironmentRuntimeClockV1,
  type ProjectEnvironmentRuntimeObservationReceiptV1,
  type ProjectObservationCoverageV1,
  type ProjectObservationLossV1,
  type ProjectRuntimeCleanupReceiptV1,
} from "@chronorift/domain";
import {
  connectGodotProjectEnvironmentRuntimeV1,
  ProjectAdapterObservationExecutionValidatorV1,
  validateProjectAdapterQueryRowsV1,
  type GodotProjectEnvironmentRuntimeClientV1,
  type LoadedProjectAdapterPackageV1,
} from "@chronorift/godot-adapter";
import {
  PROJECT_ADAPTER_REQUIRED_MODULES_V1,
  type GodotLifecycleSidecarDiagnosticV1,
  type GodotProjectEnvironmentClockV1,
  type GodotProjectEnvironmentStatusV1,
} from "@chronorift/godot-protocol";
import {
  canonicalJson,
  projectEnvironmentPackageContentDigestV1,
} from "@chronorift/json-artifacts";
import type {
  ProjectEnvironmentGameToolPort,
  ProjectEnvironmentGameToolPortRequestV1,
} from "@chronorift/pi-harness";

import type { ManagedGodotProjectEnvironmentRuntimeCapabilityV1 } from "./managed-godot-project-environment-runtime.js";
import type {
  GodotProjectEnvironmentSidecarPortV1,
  SandboxedGodotProjectEnvironmentSidecarV1,
} from "./project-environment-sidecar-port.js";

const LIMITS = Object.freeze({
  diagnosticFrameMaxBytes: 64 * 1_024,
  diagnosticTotalMaxBytes: 1_024 * 1_024,
  diagnosticMaxCount: 256,
  outputCaptureMaxBytes: 256 * 1_024,
  importTimeoutMs: 120_000,
  startupTimeoutMs: 30_000,
  executionTimeoutMs: 600_000,
  rollingRecordLimit: 4_096,
  observationWindowBatches: 8,
});

const OBSERVATION_CHANNEL_ID = "project_adapter_observations";

type GodotProjectEnvironmentCaptureCoverageV1 =
  GodotProjectEnvironmentStatusV1["coverage"];

type ErrorCode =
  | "unsupported_capability"
  | "invalid_request"
  | "resource_not_found"
  | "resource_task_mismatch"
  | "busy"
  | "runtime_crashed"
  | "runtime_unavailable"
  | "history_window_unavailable"
  | "checkpoint_incompatible"
  | "operation_failed";

interface ActiveRuntimeV1 {
  readonly runtimeId: string;
  readonly executionId: string;
  readonly observationReceiptId: string;
  readonly launchTargetId: string;
  readonly build: ProjectEnvironmentRuntimeBuildV1;
  readonly client: GodotProjectEnvironmentRuntimeClientV1;
  readonly observationValidator: ProjectAdapterObservationExecutionValidatorV1;
  readonly sidecar: SandboxedGodotProjectEnvironmentSidecarV1;
  readonly startedAt: string;
  bridgeHandshakeCount: number;
  entityQueryCount: number;
  entityRows: number;
  stateQueryCount: number;
  stateRows: number;
  pinnedCaptureCount: number;
  pinnedCaptureWindowIds: string[];
  cumulativeDroppedRecords: number;
  cumulativeOverwrittenRecords: number;
  latestClock: ProjectEnvironmentRuntimeClockV1;
  latestCoverage: GodotProjectEnvironmentCaptureCoverageV1;
  phase: "running" | "stopping" | "stopped" | "crashed" | "timed_out";
}

export interface ProjectEnvironmentRuntimeBuildV1 {
  readonly schemaVersion: 1;
  readonly buildId: string;
  readonly sourceClosureId: string;
  readonly candidateSourceHash: string;
  readonly expectedMainScene: string;
}

class ProjectEnvironmentRuntimeOperationError extends Error {
  public constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly recoverable: boolean,
  ) {
    super(message);
    this.name = "ProjectEnvironmentRuntimeOperationError";
  }
}

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const clock = (value: GodotProjectEnvironmentClockV1) => ({
  schemaVersion: 1 as const,
  ...value,
  hostMonotonicUs: Math.max(0, Math.round(performance.now() * 1_000)),
});

const coverage = (value: GodotProjectEnvironmentCaptureCoverageV1) => {
  const observedRecords =
    value.firstAvailableRecordSequence === null ||
    value.lastAvailableRecordSequence === null
      ? 0
      : value.lastAvailableRecordSequence -
        value.firstAvailableRecordSequence +
        1;
  const complete =
    value.status === "complete" &&
    value.semanticCoverage === "declared" &&
    value.droppedRecordCount === 0 &&
    value.overwriteCount === 0;
  const limitations = [
    ...(value.status === "partial"
      ? ["The bridge reported partial transport coverage."]
      : value.status === "unavailable"
        ? ["The bridge reported capture coverage as unavailable."]
        : []),
    ...(value.semanticCoverage === "partial"
      ? ["The Adapter declares partial semantic coverage."]
      : value.semanticCoverage === "unknown"
        ? ["The Adapter semantic coverage is unknown."]
        : []),
    ...(value.droppedRecordCount > 0
      ? ["The transport reported dropped observation records."]
      : []),
    ...(value.overwriteCount > 0
      ? ["The rolling transport buffer overwrote observation records."]
      : []),
  ];
  return {
    schemaVersion: 1 as const,
    channelId: OBSERVATION_CHANNEL_ID,
    status: complete
      ? ("complete" as const)
      : value.status === "unavailable"
        ? ("unavailable" as const)
        : ("incomplete" as const),
    observedRecords,
    droppedRecords: value.droppedRecordCount,
    overwrittenRecords: value.overwriteCount,
    limitations,
  };
};

const loss = (value: GodotProjectEnvironmentCaptureCoverageV1) => [
  ...(value.droppedRecordCount === 0
    ? []
    : [
        {
          schemaVersion: 1 as const,
          channelId: OBSERVATION_CHANNEL_ID,
          kind: "dropped" as const,
          count: value.droppedRecordCount,
          reason: "The bridge reported dropped observation records.",
        },
      ]),
  ...(value.overwriteCount === 0
    ? []
    : [
        {
          schemaVersion: 1 as const,
          channelId: OBSERVATION_CHANNEL_ID,
          kind: "overwritten" as const,
          count: value.overwriteCount,
          reason: "The bounded rolling observation buffer overwrote records.",
        },
      ]),
];

const success = (toolCallId: string, output: unknown) => ({
  schemaVersion: 1 as const,
  toolCallId,
  outcome: "success" as const,
  output,
});

const failure = (
  toolCallId: string,
  code: ErrorCode,
  message: string,
  recoverable: boolean,
) => ({
  schemaVersion: 1 as const,
  toolCallId,
  outcome: "error" as const,
  error: { code, message, recoverable },
});

const declaredIdLimitations = (
  label: string,
  ids: readonly string[],
): readonly string[] => {
  if (ids.length === 0) return [`Declared ${label} IDs: none.`];
  const chunks: string[] = [];
  let current = "";
  for (const id of ids) {
    const candidate = current.length === 0 ? id : `${current}, ${id}`;
    if (candidate.length > 3_900) {
      chunks.push(current);
      current = id;
    } else {
      current = candidate;
    }
  }
  chunks.push(current);
  return chunks.map(
    (chunk, index) =>
      `Declared ${label} IDs${index === 0 ? "" : " (continued)"}: ${chunk}.`,
  );
};

const phaseForStatus = (phase: ActiveRuntimeV1["phase"]) => phase;

const normalizeExposedToolNames = (
  untrustedNames: unknown,
): ReadonlySet<ProjectEnvironmentGameToolNameV1> => {
  const definitions = PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1;
  if (untrustedNames === undefined) {
    return new Set(definitions.map(({ name }) => name));
  }
  if (!Array.isArray(untrustedNames)) {
    throw new TypeError("exposedToolNames must be an array");
  }
  if (untrustedNames.length === 0) {
    throw new TypeError("exposedToolNames must not be empty");
  }
  const knownToolNames = new Set<string>(definitions.map(({ name }) => name));
  const exposedToolNames = new Set<ProjectEnvironmentGameToolNameV1>();
  for (const name of untrustedNames) {
    if (typeof name !== "string" || !knownToolNames.has(name)) {
      throw new TypeError(
        `Unknown exposed Project Environment game tool: ${String(name)}`,
      );
    }
    exposedToolNames.add(name as ProjectEnvironmentGameToolNameV1);
  }
  return exposedToolNames;
};

export interface ProjectEnvironmentGameRuntimeOptionsV1 {
  readonly sidecar: GodotProjectEnvironmentSidecarPortV1;
  readonly managedRuntime: ManagedGodotProjectEnvironmentRuntimeCapabilityV1;
  readonly adapterPackage: LoadedProjectAdapterPackageV1;
  readonly capabilitySet: ProjectCapabilitySetV1;
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
  /** Restricts both the callable and game_capabilities-declared tool surface. */
  readonly exposedToolNames?:
    readonly ProjectEnvironmentGameToolNameV1[] | undefined;
  /**
   * Freezes the current Task workspace and returns it only after the exact
   * Build has obtained a compatibility receipt. It is never called while an
   * instrumented runtime is active.
   */
  readonly resolveCompatibleBuild?: () => Promise<ProjectEnvironmentRuntimeBuildV1>;
  /** Persists only ordinary Agent runtime observations; smoke composition omits it. */
  readonly persistRuntimeObservation?: (
    receipt: ProjectEnvironmentRuntimeObservationReceiptV1,
  ) => Promise<void>;
  /** Resolves only after the exact raw observation batch is durably sealed. */
  readonly persistPinnedCapture?: (
    capture: ProjectEnvironmentPinnedCaptureV1,
    records: readonly JsonValue[],
  ) => Promise<void>;
  readonly connect?: typeof connectGodotProjectEnvironmentRuntimeV1;
  readonly now?: () => string;
}

/**
 * Task-bound PE-A runtime port. It keeps one instrumented execution alive for
 * ordinary Agent game-tool calls and never adopts identities supplied by the
 * Adapter or by another Task.
 */
export class ProjectEnvironmentGameRuntimeV1 implements ProjectEnvironmentGameToolPort {
  #active: ActiveRuntimeV1 | null = null;
  #latestBuild: ProjectEnvironmentRuntimeBuildV1;
  #operationTail: Promise<void> = Promise.resolve();
  readonly #checkpoints = new Map<string, string>();
  readonly #exposedToolNames: ReadonlySet<ProjectEnvironmentGameToolNameV1>;

  public constructor(
    private readonly options: ProjectEnvironmentGameRuntimeOptionsV1,
  ) {
    this.#exposedToolNames = normalizeExposedToolNames(
      options.exposedToolNames,
    );
    this.#latestBuild = Object.freeze({
      schemaVersion: 1,
      buildId: options.buildId,
      sourceClosureId: options.sourceClosureId,
      candidateSourceHash: options.candidateSourceHash,
      expectedMainScene: options.expectedMainScene,
    });
  }

  public async invoke(
    request: ProjectEnvironmentGameToolPortRequestV1,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.#exposedToolNames.has(request.toolName)) {
      return failure(
        request.toolCallId,
        "unsupported_capability",
        `${request.toolName} is not exposed by this Project Environment binding`,
        false,
      );
    }
    if (
      !validateProjectEnvironmentGameToolInputV1(
        request.toolName,
        request.input,
      )
    ) {
      return failure(
        request.toolCallId,
        "invalid_request",
        `Invalid ${request.toolName} input`,
        false,
      );
    }
    const input = request.input as { readonly taskId: string };
    if (input.taskId !== this.options.taskId) {
      return failure(
        request.toolCallId,
        "resource_task_mismatch",
        "The requested resource does not belong to this Task",
        false,
      );
    }
    return this.runExclusive(async () => {
      try {
        signal?.throwIfAborted();
        switch (request.toolName) {
          case "game_capabilities":
            return success(
              request.toolCallId,
              await this.capabilities(request.input),
            );
          case "game_launch":
            return success(
              request.toolCallId,
              await this.launch(
                request.input as ProjectEnvironmentGameLaunchInputV1,
              ),
            );
          case "game_status":
            return success(
              request.toolCallId,
              await this.status(
                request.input as ProjectEnvironmentGameStatusInputV1,
              ),
            );
          case "game_stop":
            return success(
              request.toolCallId,
              await this.stop(
                request.input as ProjectEnvironmentGameStatusInputV1,
              ),
            );
          case "game_capture_configure":
            return success(
              request.toolCallId,
              await this.configureCapture(
                request.input as ProjectEnvironmentGameCaptureConfigureInputV1,
              ),
            );
          case "game_capture_pin":
            return await this.pinCapture(
              request.toolCallId,
              request.input as ProjectEnvironmentGameCapturePinInputV1,
            );
          case "game_query":
            return success(
              request.toolCallId,
              await this.query(
                request.input as ProjectEnvironmentGameQueryInputV1,
              ),
            );
          case "game_input":
            return await this.input(
              request.toolCallId,
              request.input as ProjectEnvironmentGameInputInputV1,
            );
          case "game_step":
            return await this.step(
              request.toolCallId,
              request.input as ProjectEnvironmentGameStepInputV1,
            );
          case "game_set_controls":
            return success(
              request.toolCallId,
              await this.setControls(
                request.input as ProjectEnvironmentGameSetControlsInputV1,
              ),
            );
          case "game_checkpoint_create":
            return success(
              request.toolCallId,
              await this.checkpointCreate(
                request.input as ProjectEnvironmentGameCheckpointCreateInputV1,
              ),
            );
          case "game_checkpoint_restore":
            return await this.checkpointRestore(
              request.toolCallId,
              request.input as ProjectEnvironmentGameCheckpointRestoreInputV1,
            );
          case "game_fork":
          case "game_trace_create":
          case "game_trace_replay":
          case "game_compare":
            return failure(
              request.toolCallId,
              "unsupported_capability",
              `${request.toolName} requires a later Project Environment slice`,
              false,
            );
        }
      } catch (error) {
        return failure(
          request.toolCallId,
          error instanceof ProjectEnvironmentRuntimeOperationError
            ? error.code
            : this.#active?.phase === "crashed"
              ? "runtime_crashed"
              : "operation_failed",
          error instanceof Error ? error.message : String(error),
          error instanceof ProjectEnvironmentRuntimeOperationError
            ? error.recoverable
            : true,
        );
      }
    });
  }

  public async close(): Promise<void> {
    await this.runExclusive(async () => {
      if (this.#active === null) return;
      await this.finalize(this.#active);
    });
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#operationTail;
    let release!: () => void;
    this.#operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async capabilities(input: unknown) {
    const runtimeId = (input as { readonly runtimeId?: string }).runtimeId;
    if (runtimeId !== undefined) this.requireRuntime(runtimeId);
    const active = this.#active?.phase === "running" ? this.#active : null;
    const build =
      active === null ? await this.resolveLatestBuild() : active.build;
    const moduleByName = this.moduleByName();
    const hostTools = new Set<ProjectEnvironmentGameToolNameV1>([
      "game_capabilities",
      "game_launch",
      "game_status",
      "game_stop",
      "game_capture_configure",
      "game_query",
    ]);
    if (this.options.persistPinnedCapture !== undefined) {
      hostTools.add("game_capture_pin");
    }
    const manifest = this.options.adapterPackage.manifest;
    const queryLimitations = [
      "PE-A/V1 game_query supports only an unfiltered first page; the filters and cursor fields must be omitted.",
      ...declaredIdLimitations(
        "entity type",
        manifest.entityTypes.map(({ entityTypeId }) => entityTypeId),
      ),
      ...declaredIdLimitations(
        "state domain",
        manifest.stateDomains.map(({ stateDomainId }) => stateDomainId),
      ),
      ...declaredIdLimitations(
        "event type",
        manifest.eventTypes.map(({ eventTypeId }) => eventTypeId),
      ),
    ];
    return {
      schemaVersion: 1 as const,
      taskId: this.options.taskId,
      environmentRevisionId: this.options.environmentRevisionId,
      adapterRevisionId: this.options.adapterRevisionId,
      buildId: build.buildId,
      runtimeId: active?.runtimeId ?? null,
      modules: this.options.capabilitySet.modules,
      launchTargets: manifest.launchTargets.map((target) => ({
        schemaVersion: 1 as const,
        targetId: target.targetId,
        scene: target.scene,
        default: target.default,
        validationStatus: "validated" as const,
      })),
      tools: PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1.filter((tool) =>
        this.#exposedToolNames.has(tool.name),
      ).map((tool) => {
        const module =
          tool.availabilityModule === null
            ? null
            : (moduleByName.get(tool.availabilityModule) ?? null);
        const moduleAvailable =
          module === null ||
          module.status === "implemented" ||
          module.status === "degraded";
        const hostAvailable =
          hostTools.has(tool.name) ||
          tool.name === "game_input" ||
          tool.name === "game_step" ||
          tool.name === "game_set_controls" ||
          tool.name === "game_checkpoint_create" ||
          tool.name === "game_checkpoint_restore";
        const status = !moduleAvailable
          ? module?.status === "unavailable_by_policy"
            ? ("unavailable_by_policy" as const)
            : module?.status === "unavailable_by_environment"
              ? ("unavailable_by_environment" as const)
              : ("unsupported_capability" as const)
          : hostAvailable
            ? ("available" as const)
            : ("unsupported_capability" as const);
        return {
          schemaVersion: 1 as const,
          toolName: tool.name,
          module: tool.availabilityModule,
          status,
          limitations:
            status === "available"
              ? tool.name === "game_query"
                ? queryLimitations
                : []
              : module?.limitations.length
                ? module.limitations
                : ["This Host-level operation is outside PE-A."],
        };
      }),
      limitations: [
        "PE-A retains one instrumented runtime at a time.",
        "Fork, trace, and compare orchestration are not implemented in PE-A.",
      ],
    };
  }

  private async launch(input: ProjectEnvironmentGameLaunchInputV1) {
    if (this.#active?.phase === "running") {
      throw new ProjectEnvironmentRuntimeOperationError(
        "busy",
        "A Project Environment runtime is already running",
        true,
      );
    }
    if (this.#active !== null) {
      await this.finalize(this.#active);
    }
    const build = await this.resolveLatestBuild();
    if (input.buildId !== build.buildId) {
      throw new ProjectEnvironmentRuntimeOperationError(
        "resource_not_found",
        `The requested Build is stale or is not bound to this Task; call game_capabilities and use ${build.buildId}`,
        true,
      );
    }
    const target = this.options.adapterPackage.manifest.launchTargets.find(
      (candidate) => candidate.targetId === input.launchTargetId,
    );
    if (target === undefined) throw new Error("Unknown launch target");
    const parameters = input.parameters ?? {};
    if (Object.keys(parameters).length > 0) {
      throw new Error("PE-A launch targets do not accept parameters");
    }
    const runtimeId = `runtime.v1.${randomUUID()}`;
    const executionId = `execution.v1.${randomUUID()}`;
    const startedAt = this.now();
    const token = randomBytes(32).toString("hex");
    const opened = await this.options.sidecar.openManaged({
      schemaVersion: 1,
      runtimeProfile: "chronorift-managed-godot-project-environment-v1",
      taskId: this.options.taskId,
      buildId: build.buildId,
      runtimeId,
      executionId,
      managedRuntimeId: this.options.managedRuntime.managedRuntimeId,
      candidateSourceHash: build.candidateSourceHash,
      diagnosticFrameMaxBytes: LIMITS.diagnosticFrameMaxBytes,
      diagnosticTotalMaxBytes: LIMITS.diagnosticTotalMaxBytes,
      diagnosticMaxCount: LIMITS.diagnosticMaxCount,
      outputCaptureMaxBytes: LIMITS.outputCaptureMaxBytes,
      operation: "managed_lifecycle",
      protocolProfile: "chronorift-godot-project-environment-v1",
      protocolVersion: 1,
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
      importTimeoutMs: LIMITS.importTimeoutMs,
      startupTimeoutMs: LIMITS.startupTimeoutMs,
      executionTimeoutMs: LIMITS.executionTimeoutMs,
    });
    if (opened.kind !== "opened") {
      throw new Error(`Project runtime did not open: ${opened.kind}`);
    }
    const observationReceiptId = `runtime-observation-receipt.v1.${randomUUID()}`;
    const expectedIdentity = {
      taskId: this.options.taskId,
      sourceClosureId: build.sourceClosureId,
      environmentRevisionId: this.options.environmentRevisionId,
      adapterRevisionId: this.options.adapterRevisionId,
      buildId: build.buildId,
      runtimeId,
      executionId,
      instrumentationMode: "instrumented" as const,
      candidateSourceHash: build.candidateSourceHash,
      adapterManifestSha256: this.options.adapterManifestSha256,
      sdkSha256: this.options.sdkSha256,
      bridgeSha256: this.options.bridgeSha256,
      toolchainSha256: this.options.toolchainSha256,
    };
    let client: GodotProjectEnvironmentRuntimeClientV1;
    try {
      client = await (
        this.options.connect ?? connectGodotProjectEnvironmentRuntimeV1
      )(opened.sidecar.transport, {
        schemaVersion: 1,
        token,
        expectedIdentity,
        expectedEngineVersion: this.options.engineVersion,
        expectedPlatform: "Linux",
        expectedMainScene: build.expectedMainScene,
        expectedAdapterManifestSha256: this.options.adapterManifestSha256,
        requiredModules: PROJECT_ADAPTER_REQUIRED_MODULES_V1,
        observationWindowBatches: LIMITS.observationWindowBatches,
        handshakeTimeoutMs: LIMITS.startupTimeoutMs,
      });
    } catch (error) {
      await this.persistFailedLaunch({
        sidecar: opened.sidecar,
        observationReceiptId,
        runtimeId,
        executionId,
        launchTargetId: target.targetId,
        build,
        startedAt,
        error,
      });
      throw new ProjectEnvironmentRuntimeOperationError(
        "operation_failed",
        `Project Environment bridge handshake failed: ${this.errorMessage(error)}`,
        true,
      );
    }
    const active: ActiveRuntimeV1 = {
      runtimeId,
      executionId,
      observationReceiptId,
      launchTargetId: target.targetId,
      build,
      client,
      observationValidator: new ProjectAdapterObservationExecutionValidatorV1(
        this.options.adapterPackage,
      ),
      sidecar: opened.sidecar,
      startedAt,
      bridgeHandshakeCount: 1,
      entityQueryCount: 0,
      entityRows: 0,
      stateQueryCount: 0,
      stateRows: 0,
      pinnedCaptureCount: 0,
      pinnedCaptureWindowIds: [],
      cumulativeDroppedRecords: client.ready.coverage.droppedRecordCount,
      cumulativeOverwrittenRecords: client.ready.coverage.overwriteCount,
      latestClock: clock(client.ready.clock),
      latestCoverage: client.ready.coverage,
      phase: "running",
    };
    this.#active = active;
    void opened.sidecar.completion.then(
      (result) => {
        if (active.phase === "stopping" || active.phase === "stopped") return;
        active.phase =
          result.kind === "executed" && result.receipt.status === "timed_out"
            ? "timed_out"
            : "crashed";
      },
      () => {
        if (active.phase === "stopping" || active.phase === "stopped") return;
        active.phase = "crashed";
      },
    );
    return {
      schemaVersion: 1 as const,
      taskId: this.options.taskId,
      runtimeId,
      executionId,
      buildId: build.buildId,
      environmentRevisionId: this.options.environmentRevisionId,
      adapterRevisionId: this.options.adapterRevisionId,
      launchReceiptId: `launch-receipt.v1.${randomUUID()}`,
      requested: { launchTargetId: input.launchTargetId, parameters },
      realized: {
        launchTargetId: target.targetId,
        parameters,
        renderer: client.fingerprint.renderer,
        clock: active.latestClock,
      },
      status: "running" as const,
      modules: this.options.capabilitySet.modules,
      limitations: [],
    };
  }

  private async persistFailedLaunch(input: {
    readonly sidecar: SandboxedGodotProjectEnvironmentSidecarV1;
    readonly observationReceiptId: string;
    readonly runtimeId: string;
    readonly executionId: string;
    readonly launchTargetId: string;
    readonly build: ProjectEnvironmentRuntimeBuildV1;
    readonly startedAt: string;
    readonly error: unknown;
  }): Promise<void> {
    const failures = [
      `Bridge handshake failed: ${this.errorMessage(input.error)}`,
    ];
    try {
      await input.sidecar.terminate();
    } catch (error) {
      failures.push(
        `Sandbox termination after handshake failure failed: ${this.errorMessage(error)}`,
      );
    }
    let completed: Awaited<
      SandboxedGodotProjectEnvironmentSidecarV1["completion"]
    > | null = null;
    try {
      completed = await input.sidecar.completion;
    } catch (error) {
      failures.push(
        `Sandbox completion after handshake failure failed: ${this.errorMessage(error)}`,
      );
    }
    const sandboxReceipt =
      completed?.kind === "executed" ? completed.receipt : null;
    const cleanup: ProjectRuntimeCleanupReceiptV1 = {
      schemaVersion: 1,
      processTreeTerminated:
        sandboxReceipt?.cleanup.processGroupTerminated ?? false,
      runtimeExited: sandboxReceipt?.status === "succeeded",
      bridgeExited: sandboxReceipt?.status === "succeeded",
      isolationGroupEmpty: !(sandboxReceipt?.cleanup.cgroupPopulated ?? true),
      scopeRemoved: sandboxReceipt?.cleanup.scopeRemoved ?? false,
      scratchRemoved: sandboxReceipt?.cleanup.scopeRemoved ?? false,
      storageReconciled: sandboxReceipt?.cleanup.storageReconciled === true,
    };
    if (!projectRuntimeCleanupCompleteV1(cleanup)) {
      failures.push(
        "Runtime sandbox cleanup after handshake failure was incomplete.",
      );
    }
    const observedAt = this.now();
    const unavailableCoverage: ProjectObservationCoverageV1 = {
      schemaVersion: 1,
      channelId: OBSERVATION_CHANNEL_ID,
      status: "unavailable",
      observedRecords: 0,
      droppedRecords: 0,
      overwrittenRecords: 0,
      limitations: [
        "The bridge handshake failed before capture coverage could be observed.",
      ],
    };
    const observation =
      ProjectEnvironmentRuntimeObservationReceiptV1Schema.parse({
        schemaVersion: 1,
        receiptId: input.observationReceiptId,
        taskId: this.options.taskId,
        runtimeId: input.runtimeId,
        executionId: input.executionId,
        buildId: input.build.buildId,
        environmentRevisionId: this.options.environmentRevisionId,
        adapterRevisionId: this.options.adapterRevisionId,
        launchTargetId: input.launchTargetId,
        instrumentationMode: "instrumented",
        status: "stopped",
        bridgeHandshakeCount: 0,
        clock: null,
        queryObservations: {
          schemaVersion: 1,
          entityQueryCount: 0,
          entityRows: 0,
          stateQueryCount: 0,
          stateRows: 0,
        },
        captureCount: 0,
        captureWindowIds: [],
        coverage: [unavailableCoverage],
        loss: [
          {
            schemaVersion: 1,
            channelId: OBSERVATION_CHANNEL_ID,
            kind: "unavailable",
            count: 1,
            reason:
              "The bridge handshake failed before transport loss could be measured.",
          },
        ],
        cleanup,
        outcome: "incomplete",
        failures,
        startedAt: input.startedAt,
        observedAt,
        completedAt: this.now(),
      });
    try {
      await this.options.persistRuntimeObservation?.(observation);
    } catch (error) {
      throw new ProjectEnvironmentRuntimeOperationError(
        "operation_failed",
        `Bridge handshake failed and its runtime observation could not be persisted: ${this.errorMessage(error)}`,
        false,
      );
    }
  }

  private async status(input: ProjectEnvironmentGameStatusInputV1) {
    const active = this.requireRuntime(input.runtimeId);
    if (active.phase !== "running") {
      return {
        schemaVersion: 1 as const,
        taskId: this.options.taskId,
        runtimeId: active.runtimeId,
        executionId: active.executionId,
        buildId: active.build.buildId,
        status: phaseForStatus(active.phase),
        clock: active.latestClock,
        modules: this.options.capabilitySet.modules,
        coverage: [coverage(active.latestCoverage)],
        loss: loss(active.latestCoverage),
        limitations: ["The runtime is no longer accepting protocol requests."],
      };
    }
    const current = await active.client.status();
    active.latestClock = clock(current.clock);
    this.observeCoverage(active, current.coverage);
    return {
      schemaVersion: 1 as const,
      taskId: this.options.taskId,
      runtimeId: active.runtimeId,
      executionId: active.executionId,
      buildId: active.build.buildId,
      status: current.running ? ("running" as const) : ("stopped" as const),
      clock: active.latestClock,
      modules: this.options.capabilitySet.modules,
      coverage: [coverage(active.latestCoverage)],
      loss: loss(active.latestCoverage),
      limitations: [],
    };
  }

  private async stop(input: ProjectEnvironmentGameStatusInputV1) {
    const active = this.requireRuntime(input.runtimeId);
    return this.finalize(active);
  }

  private async configureCapture(
    input: ProjectEnvironmentGameCaptureConfigureInputV1,
  ) {
    const active = this.requireRunning(input.runtimeId);
    if (
      input.profile.retention.clockDomain !== "process_frame" ||
      input.profile.retention.before !== 0 ||
      input.profile.retention.after !== 0 ||
      input.profile.sampling.length > 0 ||
      input.profile.triggers.length > 0
    ) {
      throw new ProjectEnvironmentRuntimeOperationError(
        "unsupported_capability",
        "PE-A capture configuration supports only process-frame rolling capture with zero explicit before/after retention, no sampling rules, and no triggers; use game_capture_pin to retain one current bounded batch",
        false,
      );
    }
    const configured = await active.client.configureCapture({
      channels: input.profile.channels,
      rollingRecordLimit: LIMITS.rollingRecordLimit,
    });
    const current = await active.client.status();
    active.latestClock = clock(current.clock);
    this.observeCoverage(active, current.coverage);
    const channelsExact =
      configured.channels.length === input.profile.channels.length &&
      new Set(configured.channels).size === configured.channels.length &&
      configured.channels.every((channel) =>
        input.profile.channels.includes(channel),
      );
    const rollingLimitExact =
      configured.realizedRollingRecordLimit === LIMITS.rollingRecordLimit;
    return {
      schemaVersion: 1 as const,
      taskId: this.options.taskId,
      runtimeId: active.runtimeId,
      captureProfileId: `capture-profile.v1.${digest(input.profile)}`,
      status:
        channelsExact && rollingLimitExact
          ? ("configured" as const)
          : ("degraded" as const),
      realized: {
        channels: configured.channels,
        rollingRecordLimit: configured.realizedRollingRecordLimit,
        retention: {
          clockDomain: "process_frame",
          before: 0,
          after: 0,
        },
        sampling: [],
        triggers: [],
      },
      coverage: [coverage(active.latestCoverage)],
      loss: loss(active.latestCoverage),
      limitations: [
        ...(channelsExact
          ? []
          : [
              "The bridge captures a fixed channel set rather than the requested channel subset.",
            ]),
        ...(rollingLimitExact
          ? []
          : ["The bridge realized a different rolling record bound."]),
      ],
    };
  }

  private async pinCapture(
    toolCallId: string,
    input: ProjectEnvironmentGameCapturePinInputV1,
  ) {
    const active = this.requireRunning(input.runtimeId);
    if (
      input.anchor.kind !== "now" ||
      input.before !== 0 ||
      input.after !== 0
    ) {
      return failure(
        toolCallId,
        "history_window_unavailable",
        "PE-A can durably pin only one current transport batch with zero before/after expansion",
        true,
      );
    }
    if (this.options.persistPinnedCapture === undefined) {
      return failure(
        toolCallId,
        "unsupported_capability",
        "No durable pinned-capture store is configured for this runtime",
        false,
      );
    }
    const batch = await active.client.nextObservationBatch(2_000);
    for (const record of batch.records) {
      active.observationValidator.validate(record);
    }
    const realized = batch.records.at(-1)?.clock;
    if (realized === undefined) {
      return failure(
        toolCallId,
        "history_window_unavailable",
        "No observation record was available to pin",
        true,
      );
    }
    active.latestClock = clock(realized);
    this.observeCoverage(active, batch.coverage);
    const records = batch.records.map((record) =>
      JsonValueSchema.parse(record),
    );
    const recordsBytes = Buffer.from(`${canonicalJson(records)}\n`, "utf8");
    const captureWindowId = `capture-window.v1.${randomUUID()}`;
    const pinned = ProjectEnvironmentPinnedCaptureV1Schema.parse({
      schemaVersion: 1,
      captureWindowId,
      taskId: this.options.taskId,
      runtimeId: active.runtimeId,
      executionId: active.executionId,
      buildId: active.build.buildId,
      environmentRevisionId: this.options.environmentRevisionId,
      adapterRevisionId: this.options.adapterRevisionId,
      recordCount: records.length,
      contentDigest: projectEnvironmentPackageContentDigestV1([
        { path: "records.json", bytes: recordsBytes },
      ]),
      anchorClock: active.latestClock,
      coverage: [coverage(active.latestCoverage)],
      loss: loss(active.latestCoverage),
      createdAt: this.now(),
    });
    await this.options.persistPinnedCapture(pinned, records);
    await active.client.acknowledgeObservationBatch(
      batch,
      LIMITS.observationWindowBatches,
    );
    active.pinnedCaptureCount += 1;
    active.pinnedCaptureWindowIds.push(captureWindowId);
    return success(toolCallId, {
      schemaVersion: 1 as const,
      taskId: this.options.taskId,
      runtimeId: active.runtimeId,
      captureWindowId,
      anchor: {
        requested: input.anchor,
        realized: active.latestClock,
        quantized: true,
      },
      coverage: [coverage(active.latestCoverage)],
      loss: loss(active.latestCoverage),
      limitations: [
        `The durable PE-A window contains one exact transport batch (${batch.records.length} records); its realized anchor is quantized to the last retained record.`,
      ],
    });
  }

  private async query(input: ProjectEnvironmentGameQueryInputV1) {
    const active = this.requireExecution(input.executionId);
    if (input.cursor !== undefined || input.filters !== undefined) {
      throw new ProjectEnvironmentRuntimeOperationError(
        "unsupported_capability",
        "PE-A/V1 game_query supports only an unfiltered first page; omit filters and cursor",
        true,
      );
    }
    if (input.select === "clocks" || input.select === "coverage") {
      const current = await active.client.status();
      active.latestClock = clock(current.clock);
      this.observeCoverage(active, current.coverage);
      const value =
        input.select === "clocks"
          ? active.latestClock
          : coverage(active.latestCoverage);
      return {
        schemaVersion: 1 as const,
        taskId: this.options.taskId,
        executionId: active.executionId,
        rows: [
          {
            schemaVersion: 1 as const,
            rowId: `query-row.v1.${digest(value)}`,
            kind:
              input.select === "clocks"
                ? ("clock" as const)
                : ("coverage" as const),
            clock: active.latestClock,
            value,
          },
        ],
        nextCursor: null,
        coverage: [coverage(active.latestCoverage)],
        loss: loss(active.latestCoverage),
        limitations: [],
      };
    }
    const queryKind =
      input.select === "runtime_errors" ? ("errors" as const) : input.select;
    const result = await active.client.query({
      queryKind,
      ids: [],
      limit: input.limit,
    });
    const validatedRows = validateProjectAdapterQueryRowsV1(
      this.options.adapterPackage,
      queryKind,
      result.rows,
    );
    this.observeCoverage(active, result.coverage);
    if (input.select === "entities") {
      active.entityQueryCount += 1;
      active.entityRows += validatedRows.length;
    } else if (input.select === "state") {
      active.stateQueryCount += 1;
      active.stateRows += validatedRows.length;
    }
    const kind =
      input.select === "runtime_errors"
        ? ("runtime_error" as const)
        : input.select === "events"
          ? ("event" as const)
          : input.select === "entities"
            ? ("entity" as const)
            : ("state" as const);
    return {
      schemaVersion: 1 as const,
      taskId: this.options.taskId,
      executionId: active.executionId,
      rows: validatedRows.map((value, index) => ({
        schemaVersion: 1 as const,
        rowId: `query-row.v1.${digest([active.executionId, kind, index, value])}`,
        kind,
        clock: null,
        value,
      })),
      nextCursor: null,
      coverage: [coverage(active.latestCoverage)],
      loss: loss(active.latestCoverage),
      limitations: result.truncated
        ? [
            "The bridge truncated this bounded query; PE-A has no cursor continuation.",
          ]
        : [],
    };
  }

  private async input(
    toolCallId: string,
    input: ProjectEnvironmentGameInputInputV1,
  ) {
    const active = this.requireRunning(input.runtimeId);
    const phase = this.wirePhase(input.requested.clockDomain);
    if (phase === null) {
      return failure(
        toolCallId,
        "unsupported_capability",
        "PE-A cannot schedule input in the requested clock domain",
        false,
      );
    }
    const applied = await active.client.input({
      controlId: input.controlId,
      parameters: {
        ...(input.parameters ?? {}),
        ...(input.targetEntityId === undefined
          ? {}
          : { targetEntityId: input.targetEntityId }),
      },
      phase,
      duration: {
        clock: phase === "process" ? "process_frame" : "physics_tick",
        count: 1,
      },
    });
    return success(toolCallId, {
      schemaVersion: 1 as const,
      taskId: this.options.taskId,
      runtimeId: active.runtimeId,
      controlReceiptId: `control-receipt.v1.${randomUUID()}`,
      controlId: input.controlId,
      requested: {
        point: input.requested,
        parameters: input.parameters ?? {},
      },
      realized: {
        accepted: true,
        clock: clock(applied.startClock),
        phase:
          applied.realizedPhase === "process"
            ? "process_frame_start"
            : "physics_tick_start",
        quantized:
          applied.requestedPhase !== applied.realizedPhase ||
          applied.requestedDuration.count !== applied.realizedDuration.count,
        sideEffects: applied.knownSideEffects,
      },
      limitations: [],
    });
  }

  private async step(
    toolCallId: string,
    input: ProjectEnvironmentGameStepInputV1,
  ) {
    const active = this.requireRunning(input.runtimeId);
    if (input.requested.clockDomain === "simulation_time") {
      return failure(
        toolCallId,
        "unsupported_capability",
        "PE-A bridge stepping supports process_frame and physics_tick only",
        false,
      );
    }
    const stepped = await active.client.step({
      clock: input.requested.clockDomain,
      count: input.requested.count,
    });
    const current = await active.client.status();
    active.latestClock = clock(current.clock);
    this.observeCoverage(active, current.coverage);
    return success(toolCallId, {
      schemaVersion: 1 as const,
      taskId: this.options.taskId,
      runtimeId: active.runtimeId,
      requested: input.requested,
      before: clock(stepped.startClock),
      after: clock(stepped.endClock),
      realizedCount: stepped.realizedCount,
      realizedDurationUs: Math.max(
        0,
        stepped.endClock.simulationTimeUs - stepped.startClock.simulationTimeUs,
      ),
      quantized:
        stepped.realizedCount !== stepped.requestedCount ||
        stepped.quantizationDelayUs > 0,
      coverage: [coverage(active.latestCoverage)],
      loss: loss(active.latestCoverage),
      limitations: [],
    });
  }

  private async setControls(input: ProjectEnvironmentGameSetControlsInputV1) {
    const active = this.requireRunning(input.runtimeId);
    const result = await active.client.setControls({
      controls: input.controls.map((control) => ({
        controlId: control.controlId,
        parameters: control.value,
        active: true,
      })),
      requestedBarrier: "process_frame_end",
    });
    const requested = new Map(
      input.controls.map((control) => [control.controlId, control.value]),
    );
    return {
      schemaVersion: 1 as const,
      taskId: this.options.taskId,
      runtimeId: active.runtimeId,
      requested: input.controls,
      realized: result.realizedControls.map((control) => ({
        controlId: control.controlId,
        requested: requested.get(control.controlId) ?? null,
        realized: control.realizedParameters,
        status: control.active ? ("applied" as const) : ("rejected" as const),
        reason: control.active
          ? null
          : "The Adapter reported the control inactive.",
        sideEffects: [],
      })),
      clock: clock(result.clock),
      limitations:
        result.quantizationDelayUs > 0
          ? ["The control barrier was quantized by the runtime."]
          : [],
    };
  }

  private async checkpointCreate(
    input: ProjectEnvironmentGameCheckpointCreateInputV1,
  ) {
    const active = this.requireRunning(input.runtimeId);
    const barrier = this.barrier(input.barrierId);
    const snapshot = await active.client.snapshot({
      requestedBarrier: barrier,
    });
    const checkpointId = `checkpoint.v1.${snapshot.snapshotId}`;
    this.#checkpoints.set(checkpointId, snapshot.snapshotId);
    const schemaHashes = new Map(
      this.options.adapterPackage.manifest.schemas.map((schema) => [
        schema.schemaId,
        schema.sha256,
      ]),
    );
    const domains = snapshot.domains
      .filter(
        (domain) =>
          input.domainIds === undefined ||
          input.domainIds.includes(domain.stateDomainId),
      )
      .map((domain) => ({
        schemaVersion: 1 as const,
        domainId: domain.stateDomainId,
        disposition: domain.disposition,
        schemaDigest:
          domain.schemaId === null
            ? null
            : (schemaHashes.get(domain.schemaId) ?? null),
        limitations: domain.limitations,
      }));
    const current = await active.client.status();
    active.latestClock = clock(current.clock);
    this.observeCoverage(active, current.coverage);
    return {
      schemaVersion: 1 as const,
      taskId: this.options.taskId,
      runtimeId: active.runtimeId,
      checkpointId,
      requestedBarrierId: input.barrierId,
      realizedBarrierId: snapshot.realizedBarrier,
      clock: clock(snapshot.clock),
      domains,
      contentDigest: digest(snapshot.domains),
      coverage: [coverage(active.latestCoverage)],
      limitations: [
        "Checkpoint success reports Adapter-declared state only; it is not an equivalent-start claim.",
      ],
    };
  }

  private async checkpointRestore(
    toolCallId: string,
    input: ProjectEnvironmentGameCheckpointRestoreInputV1,
  ) {
    const active = this.requireRunning(input.runtimeId);
    const snapshotId = this.#checkpoints.get(input.checkpointId);
    if (snapshotId === undefined) {
      return failure(
        toolCallId,
        "checkpoint_incompatible",
        "The checkpoint is not owned by this runtime port",
        false,
      );
    }
    const restored = await active.client.restore({
      snapshotId,
      requestedBarrier: "process_frame_end",
    });
    const domains = restored.domains.map((domain) => ({
      schemaVersion: 1 as const,
      domainId: domain.stateDomainId,
      requested: true,
      reportedWritten: domain.status === "written",
      readBackMatched: null,
      status: domain.status,
      sideEffects: domain.knownSideEffects,
      limitations: [
        ...domain.limitations,
        ...(domain.status === "written"
          ? [
              "PE-A records the Adapter write report; read-back conformance is not established by this tool call.",
            ]
          : []),
      ],
    }));
    return success(toolCallId, {
      schemaVersion: 1 as const,
      taskId: this.options.taskId,
      runtimeId: active.runtimeId,
      checkpointId: input.checkpointId,
      restoreReceiptId: `restore-receipt.v1.${randomUUID()}`,
      status: domains.every((domain) => domain.status === "written")
        ? "restored"
        : domains.some((domain) => domain.status === "written")
          ? "partial"
          : "failed",
      domains,
      clock: clock(restored.clock),
      firstDivergence: null,
      limitations: [
        "Restore is limited to declared domains and does not prove an equivalent start.",
      ],
    });
  }

  private async finalize(active: ActiveRuntimeV1) {
    if (active.phase === "stopping") {
      throw new Error("Project Environment runtime is already stopping");
    }
    const phaseBeforeStop = active.phase;
    active.phase = "stopping";
    let shutdownFailure: string | null = null;
    let completionFailure: string | null = null;
    if (phaseBeforeStop === "running") {
      try {
        const shutdown = await active.client.shutdown();
        active.latestClock = clock(shutdown.status.clock);
        this.observeCoverage(active, shutdown.status.coverage);
      } catch (error) {
        shutdownFailure = `Bridge shutdown failed: ${this.errorMessage(error)}`;
        await active.sidecar.terminate().catch(() => undefined);
      }
    } else {
      shutdownFailure = `Runtime entered ${phaseBeforeStop} before an orderly stop.`;
      await active.sidecar.terminate().catch(() => undefined);
    }

    let completed: Awaited<
      SandboxedGodotProjectEnvironmentSidecarV1["completion"]
    > | null = null;
    try {
      completed = await active.sidecar.completion;
    } catch (error) {
      completionFailure = `Sandbox completion failed: ${this.errorMessage(error)}`;
    }
    const observedAt = this.now();
    active.phase = "stopped";
    if (this.#active === active) this.#active = null;
    const sandboxReceipt =
      completed?.kind === "executed" ? completed.receipt : null;
    const cleanup: ProjectRuntimeCleanupReceiptV1 = {
      schemaVersion: 1,
      processTreeTerminated:
        sandboxReceipt?.cleanup.processGroupTerminated ?? false,
      runtimeExited: sandboxReceipt?.status === "succeeded",
      bridgeExited: sandboxReceipt?.status === "succeeded",
      isolationGroupEmpty: !(sandboxReceipt?.cleanup.cgroupPopulated ?? true),
      scopeRemoved: sandboxReceipt?.cleanup.scopeRemoved ?? false,
      scratchRemoved: sandboxReceipt?.cleanup.scopeRemoved ?? false,
      storageReconciled: sandboxReceipt?.cleanup.storageReconciled === true,
    };
    const finalCoverage = {
      ...active.latestCoverage,
      status:
        active.cumulativeDroppedRecords > 0 ||
        active.cumulativeOverwrittenRecords > 0
          ? ("partial" as const)
          : active.latestCoverage.status,
      droppedRecordCount: active.cumulativeDroppedRecords,
      overwriteCount: active.cumulativeOverwrittenRecords,
    };
    const observedCoverage: ProjectObservationCoverageV1[] = [
      coverage(finalCoverage),
    ];
    const observedLoss: ProjectObservationLossV1[] = loss(finalCoverage);
    const failures = [
      ...(shutdownFailure === null ? [] : [shutdownFailure]),
      ...(completionFailure === null ? [] : [completionFailure]),
      ...(completed?.kind === "denied"
        ? ["The sandbox denied the runtime completion."]
        : []),
      ...(active.bridgeHandshakeCount > 0
        ? []
        : ["No instrumented bridge handshake was observed."]),
      ...(active.entityQueryCount > 0 && active.entityRows > 0
        ? []
        : ["No nonempty entity query was observed."]),
      ...(active.stateQueryCount > 0 && active.stateRows > 0
        ? []
        : ["No nonempty state query was observed."]),
      ...(active.pinnedCaptureCount > 0
        ? []
        : ["No pinned observation batch was captured."]),
      ...(observedCoverage.every(
        (entry) =>
          entry.status === "complete" &&
          entry.observedRecords > 0 &&
          entry.droppedRecords === 0 &&
          entry.overwrittenRecords === 0,
      ) && observedLoss.length === 0
        ? []
        : ["Runtime observation coverage was incomplete or lossy."]),
      ...(projectRuntimeCleanupCompleteV1(cleanup)
        ? []
        : ["Runtime sandbox cleanup was incomplete."]),
    ];
    const observation =
      ProjectEnvironmentRuntimeObservationReceiptV1Schema.parse({
        schemaVersion: 1,
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
        bridgeHandshakeCount: active.bridgeHandshakeCount,
        clock: active.latestClock,
        queryObservations: {
          schemaVersion: 1,
          entityQueryCount: active.entityQueryCount,
          entityRows: active.entityRows,
          stateQueryCount: active.stateQueryCount,
          stateRows: active.stateRows,
        },
        captureCount: active.pinnedCaptureCount,
        captureWindowIds: [...active.pinnedCaptureWindowIds],
        coverage: observedCoverage,
        loss: observedLoss,
        cleanup,
        outcome: failures.length === 0 ? "succeeded" : "incomplete",
        failures,
        startedAt: active.startedAt,
        observedAt,
        completedAt: this.now(),
      });
    await this.options.persistRuntimeObservation?.(observation);
    return {
      schemaVersion: 1 as const,
      taskId: this.options.taskId,
      runtimeId: active.runtimeId,
      executionId: active.executionId,
      status: "stopped" as const,
      cleanup,
      coverage: observedCoverage,
      loss: observedLoss,
      limitations: [
        ...(sandboxReceipt?.status === "succeeded"
          ? []
          : ["The runtime did not return a successful sandbox receipt."]),
        ...this.managedImportLimitations(active.sidecar.diagnostics()),
      ],
    };
  }

  private managedImportLimitations(
    diagnostics: readonly GodotLifecycleSidecarDiagnosticV1[],
  ): string[] {
    const result = diagnostics.find(
      (diagnostic) => diagnostic.kind === "managed_import_result",
    );
    if (
      result?.kind !== "managed_import_result" ||
      result.receipt.stderr.totalBytes === 0
    ) {
      return [];
    }
    const stderr = result.receipt.stderr;
    return [
      `Managed Godot import emitted ${stderr.totalBytes} stderr bytes (sha256 ${stderr.sha256}; retained ${stderr.retainedBytes}; truncated ${String(stderr.truncated)}).`,
    ];
  }

  private now(): string {
    return (this.options.now ?? (() => new Date().toISOString()))();
  }

  private observeCoverage(
    active: ActiveRuntimeV1,
    observed: GodotProjectEnvironmentCaptureCoverageV1,
  ): void {
    active.cumulativeDroppedRecords = Math.max(
      active.cumulativeDroppedRecords,
      observed.droppedRecordCount,
    );
    active.cumulativeOverwrittenRecords = Math.max(
      active.cumulativeOverwrittenRecords,
      observed.overwriteCount,
    );
    const semanticCoverage =
      active.latestCoverage.semanticCoverage === "unknown" ||
      observed.semanticCoverage === "unknown"
        ? ("unknown" as const)
        : active.latestCoverage.semanticCoverage === "partial" ||
            observed.semanticCoverage === "partial"
          ? ("partial" as const)
          : ("declared" as const);
    const status =
      active.latestCoverage.status === "unavailable" ||
      observed.status === "unavailable"
        ? ("unavailable" as const)
        : active.cumulativeDroppedRecords > 0 ||
            active.cumulativeOverwrittenRecords > 0 ||
            active.latestCoverage.status === "partial" ||
            observed.status === "partial"
          ? ("partial" as const)
          : ("complete" as const);
    active.latestCoverage = {
      ...observed,
      status,
      droppedRecordCount: active.cumulativeDroppedRecords,
      overwriteCount: active.cumulativeOverwrittenRecords,
      semanticCoverage,
    };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async resolveLatestBuild(): Promise<ProjectEnvironmentRuntimeBuildV1> {
    if (this.options.resolveCompatibleBuild === undefined) {
      return this.#latestBuild;
    }
    if (this.#active?.phase === "running") {
      return this.#active.build;
    }
    const resolved = await this.options.resolveCompatibleBuild();
    const defaultTarget =
      this.options.adapterPackage.manifest.launchTargets.find(
        (target) => target.default,
      );
    if (
      resolved.schemaVersion !== 1 ||
      resolved.buildId.length === 0 ||
      resolved.sourceClosureId.length === 0 ||
      !/^[0-9a-f]{64}$/.test(resolved.candidateSourceHash) ||
      defaultTarget === undefined ||
      resolved.expectedMainScene !== defaultTarget.scene
    ) {
      throw new ProjectEnvironmentRuntimeOperationError(
        "operation_failed",
        "The compatible Build resolver returned an invalid or Adapter-incompatible binding",
        false,
      );
    }
    this.#latestBuild = Object.freeze({ ...resolved });
    return this.#latestBuild;
  }

  private moduleByName() {
    return new Map(
      this.options.capabilitySet.modules.map((module) => [
        module.module,
        module,
      ]),
    );
  }

  private requireRuntime(runtimeId: string): ActiveRuntimeV1 {
    if (this.#active === null || this.#active.runtimeId !== runtimeId) {
      throw new Error("Unknown task-owned runtime");
    }
    return this.#active;
  }

  private requireRunning(runtimeId: string): ActiveRuntimeV1 {
    const active = this.requireRuntime(runtimeId);
    if (active.phase !== "running") {
      throw new Error(`Runtime is ${active.phase}`);
    }
    return active;
  }

  private requireExecution(executionId: string): ActiveRuntimeV1 {
    const active = this.#active;
    if (active === null || active.executionId !== executionId) {
      throw new Error("Unknown task-owned execution");
    }
    if (active.phase !== "running")
      throw new Error(`Runtime is ${active.phase}`);
    return active;
  }

  private wirePhase(domain: string): "process" | "physics" | null {
    if (domain === "process_frame") return "process";
    if (domain === "physics_tick") return "physics";
    return null;
  }

  private barrier(value: string) {
    if (
      value === "process_frame_end" ||
      value === "physics_tick_end" ||
      value === "render_complete"
    ) {
      return value;
    }
    throw new Error(`Unknown PE-A barrier: ${value}`);
  }
}
