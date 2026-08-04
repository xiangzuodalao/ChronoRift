import type {
  EnvironmentEventDraft,
  EnvironmentRef,
  EnvironmentSnapshot,
  JsonObject,
  Microseconds,
  StateSnapshot,
  Tick,
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

/** State is captured after every event and process callback in the frame. */
export interface FrameObservation {
  readonly events: readonly EnvironmentEventDraft[];
  readonly state: StateSnapshot;
}

export interface GameEnvironmentPort {
  readonly descriptor: EnvironmentRef;
  restore(snapshot: EnvironmentSnapshot): Promise<void>;
  step(command: FrameCommand): Promise<FrameObservation>;
  snapshot(): Promise<EnvironmentSnapshot>;
  dispose(): Promise<void>;
}

export interface GameEnvironmentFactoryPort {
  create(environment: EnvironmentRef): Promise<GameEnvironmentPort>;
}
