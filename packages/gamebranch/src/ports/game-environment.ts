import type {
  BranchControls,
  BranchId,
  CheckpointCertificateV1,
  EnvironmentRef,
  EnvironmentSnapshot,
  ExecutionId,
  JsonObject,
  Microseconds,
  RestoreValidationV1,
  RunId,
  RuntimeCapability,
  RuntimeStepReceiptV1,
  StateSnapshot,
  Tick,
  V01EnvironmentEventDraft,
} from "@chronorift/domain";

/** Input delivered at the start of a frame. Runtime events may cite localId. */
export interface RuntimeInput {
  readonly localId: string;
  readonly order: number;
  readonly action: string;
  readonly target?: string;
  readonly payload: JsonObject;
}

export interface FrameCommand {
  readonly tick: Tick;
  readonly simTimeUs: Microseconds;
  readonly deltaUs: Microseconds;
  readonly inputs: readonly RuntimeInput[];
}

export interface RuntimeProbePlan {
  readonly schemaVersion: 1;
  readonly signals: readonly {
    readonly source: string;
    readonly name: string;
  }[];
  readonly properties: readonly string[];
}

export interface GameEnvironmentLaunchRequest {
  readonly environment: EnvironmentRef;
  readonly runId: RunId;
  readonly branchId: BranchId;
  readonly executionId: ExecutionId;
  readonly controls: BranchControls;
  readonly requiredCapabilities: readonly RuntimeCapability[];
  readonly probePlan: RuntimeProbePlan;
}

export interface EnvironmentRestoreRequest {
  readonly snapshot: EnvironmentSnapshot;
  readonly certificate?: CheckpointCertificateV1 | undefined;
  readonly nextTick: Tick;
  readonly simTimeUs: Microseconds;
}

/** Adapter acknowledgement for an actually applied restore. */
export interface RestoreReceipt {
  readonly restored: true;
  readonly nextTick: Tick;
  readonly simTimeUs: Microseconds;
  readonly state: StateSnapshot;
  readonly runtimeValidation?: RestoreValidationV1 | undefined;
}

/** Requested controls are distinct from values realized by the runtime. */
export interface StepReceipt {
  readonly requestedTick: Tick;
  readonly realizedTick: Tick;
  readonly requestedDeltaUs: Microseconds;
  readonly realizedDeltaUs: Microseconds;
  readonly appliedInputOrders: readonly number[];
  readonly runtime?: RuntimeStepReceiptV1 | undefined;
}

/** State is captured after every event and process callback in the frame. */
export interface FrameObservation {
  readonly events: readonly V01EnvironmentEventDraft[];
  readonly state: StateSnapshot;
  readonly receipt: StepReceipt;
}

export interface GameEnvironmentPort {
  readonly descriptor: EnvironmentRef;
  restore(request: EnvironmentRestoreRequest): Promise<RestoreReceipt>;
  step(command: FrameCommand): Promise<FrameObservation>;
  snapshot(): Promise<{
    readonly snapshot: EnvironmentSnapshot;
    readonly certificate?: CheckpointCertificateV1 | undefined;
  }>;
  dispose(): Promise<void>;
}

export interface GameEnvironmentFactoryPort {
  create(request: GameEnvironmentLaunchRequest): Promise<GameEnvironmentPort>;
}
