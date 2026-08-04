import type {
  EnvironmentRef,
  EnvironmentSnapshot,
  JsonObject,
  Microseconds,
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

/** Adapter acknowledgement for an actually applied restore. */
export interface RestoreReceipt {
  readonly restored: true;
  readonly nextTick: Tick;
  readonly simTimeUs: Microseconds;
  readonly state: StateSnapshot;
}

/** Requested controls are distinct from values realized by the runtime. */
export interface StepReceipt {
  readonly requestedTick: Tick;
  readonly realizedTick: Tick;
  readonly requestedDeltaUs: Microseconds;
  readonly realizedDeltaUs: Microseconds;
  readonly appliedInputOrders: readonly number[];
}

/** State is captured after every event and process callback in the frame. */
export interface FrameObservation {
  readonly events: readonly V01EnvironmentEventDraft[];
  readonly state: StateSnapshot;
  readonly receipt: StepReceipt;
}

export interface GameEnvironmentPort {
  readonly descriptor: EnvironmentRef;
  restore(snapshot: EnvironmentSnapshot): Promise<RestoreReceipt>;
  step(command: FrameCommand): Promise<FrameObservation>;
  snapshot(): Promise<EnvironmentSnapshot>;
  dispose(): Promise<void>;
}

export interface GameEnvironmentFactoryPort {
  create(environment: EnvironmentRef): Promise<GameEnvironmentPort>;
}
