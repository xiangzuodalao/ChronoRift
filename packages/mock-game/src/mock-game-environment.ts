import {
  EnvironmentSnapshotSchema,
  type EnvironmentRef,
  type EnvironmentSnapshot,
  type JsonObject,
  type JsonValue,
  type StateSnapshot,
  type V01EnvironmentEventDraft,
} from "@chronorift/domain";
import type {
  FrameCommand,
  FrameObservation,
  GameEnvironmentFactoryPort,
  GameEnvironmentLaunchRequest,
  GameEnvironmentPort,
  RestoreReceipt,
  RuntimeInput,
} from "@chronorift/gamebranch";

import {
  DOOR_OPEN_PATH,
  DOOR_RECEIVER_CONNECTED_PATH,
  DOOR_SIGNAL_RECEIVER,
  INITIAL_RNG_STATE,
  INTERACT_SWITCH_ACTION,
  MOCK_GAME_ADAPTER,
  MOCK_GAME_ADAPTER_VERSION,
  MOCK_GAME_SCENE,
  SWITCH_ACTIVATED_SIGNAL,
  SWITCH_ACTIVE_PATH,
  SWITCH_TARGET,
} from "./constants.js";

export const MOCK_GAME_ENVIRONMENT_REF: EnvironmentRef = Object.freeze({
  adapter: MOCK_GAME_ADAPTER,
  adapterVersion: MOCK_GAME_ADAPTER_VERSION,
  scene: MOCK_GAME_SCENE,
  build: "v0.1",
});

interface MutableRuntimeState {
  nowUs: number;
  nextTick: number;
  switchActive: boolean;
  doorOpen: boolean;
  receiverConnected: boolean;
  receiverInitializationPending: boolean;
  rngState: number;
}

const INITIAL_RUNTIME_STATE: Readonly<MutableRuntimeState> = Object.freeze({
  nowUs: 0,
  nextTick: 0,
  switchActive: false,
  doorOpen: false,
  receiverConnected: false,
  receiverInitializationPending: true,
  rngState: INITIAL_RNG_STATE,
});

const isJsonObject = (value: JsonValue): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const expectObject = (value: JsonValue, label: string): JsonObject => {
  if (!isJsonObject(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value;
};

const expectSafeInteger = (value: JsonValue, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a safe integer`);
  }
  return value;
};

const expectNonNegativeInteger = (value: JsonValue, label: string): number => {
  const result = expectSafeInteger(value, label);
  if (result < 0) {
    throw new RangeError(`${label} must be non-negative`);
  }
  return result;
};

const expectBoolean = (value: JsonValue, label: string): boolean => {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
};

const readState = (
  snapshot: StateSnapshot,
): Pick<
  MutableRuntimeState,
  "switchActive" | "doorOpen" | "receiverConnected"
> => ({
  switchActive: expectBoolean(
    snapshot.values[SWITCH_ACTIVE_PATH] ?? null,
    `state.${SWITCH_ACTIVE_PATH}`,
  ),
  doorOpen: expectBoolean(
    snapshot.values[DOOR_OPEN_PATH] ?? null,
    `state.${DOOR_OPEN_PATH}`,
  ),
  receiverConnected: expectBoolean(
    snapshot.values[DOOR_RECEIVER_CONNECTED_PATH] ?? null,
    `state.${DOOR_RECEIVER_CONNECTED_PATH}`,
  ),
});

const copyDescriptor = (): EnvironmentRef => ({
  ...MOCK_GAME_ENVIRONMENT_REF,
});

const makeStateSnapshot = (
  switchActive: boolean,
  doorOpen: boolean,
  receiverConnected: boolean,
): StateSnapshot => ({
  values: {
    [SWITCH_ACTIVE_PATH]: switchActive,
    [DOOR_OPEN_PATH]: doorOpen,
    [DOOR_RECEIVER_CONNECTED_PATH]: receiverConnected,
  },
});

export const createInitialMockSnapshot = (): EnvironmentSnapshot => ({
  state: makeStateSnapshot(false, false, false),
  runtimeState: {
    nowUs: INITIAL_RUNTIME_STATE.nowUs,
    nextTick: INITIAL_RUNTIME_STATE.nextTick,
  },
  rngState: {
    state: INITIAL_RUNTIME_STATE.rngState,
  },
  pendingEffects: {
    receiverInitializationPending: true,
  },
});

/**
 * Deterministic v0.1 fixture with one deliberate initialization-order defect.
 *
 * Inputs execute before the door connects its signal receiver on the first
 * tick. A tick-0 interaction therefore emits a signal that is not delivered;
 * connecting later does not replay it. Delaying only that input to tick 1
 * makes the same signal deliver and opens the door.
 */
export class MockGameEnvironment implements GameEnvironmentPort {
  readonly descriptor: EnvironmentRef = copyDescriptor();

  private state: MutableRuntimeState = { ...INITIAL_RUNTIME_STATE };
  private disposed = false;

  restore(request: {
    readonly snapshot: EnvironmentSnapshot;
  }): Promise<RestoreReceipt> {
    this.assertNotDisposed();
    const parsed = EnvironmentSnapshotSchema.parse(request.snapshot);
    const runtime = expectObject(parsed.runtimeState, "runtimeState");
    const pendingEffects = expectObject(
      parsed.pendingEffects,
      "pendingEffects",
    );
    const rng = expectObject(parsed.rngState, "rngState");
    const state = readState(parsed.state);
    const receiverInitializationPending = expectBoolean(
      pendingEffects.receiverInitializationPending ?? null,
      "pendingEffects.receiverInitializationPending",
    );

    if (state.receiverConnected === receiverInitializationPending) {
      throw new Error(
        "Receiver connection and initialization-pending state are inconsistent",
      );
    }

    this.state = {
      nowUs: expectNonNegativeInteger(
        runtime.nowUs ?? null,
        "runtimeState.nowUs",
      ),
      nextTick: expectNonNegativeInteger(
        runtime.nextTick ?? null,
        "runtimeState.nextTick",
      ),
      switchActive: state.switchActive,
      doorOpen: state.doorOpen,
      receiverConnected: state.receiverConnected,
      receiverInitializationPending,
      rngState: expectNonNegativeInteger(rng.state ?? null, "rngState.state"),
    };

    return Promise.resolve({
      restored: true,
      nextTick: this.state.nextTick,
      simTimeUs: this.state.nowUs,
      state: this.currentState(),
    });
  }

  step(command: FrameCommand): Promise<FrameObservation> {
    this.assertNotDisposed();
    this.assertFrameCommand(command);

    const events: V01EnvironmentEventDraft[] = [];
    const seenInputIds = new Set<string>();

    for (const input of command.inputs) {
      if (seenInputIds.has(input.localId)) {
        throw new Error(`Duplicate runtime input localId: ${input.localId}`);
      }
      seenInputIds.add(input.localId);
      this.handleInput(command, input, events);
    }

    this.finishReceiverInitialization(command.tick, events);

    const frameEndUs = command.simTimeUs + command.deltaUs;
    if (!Number.isSafeInteger(frameEndUs)) {
      throw new RangeError("Frame end time exceeds the safe integer range");
    }
    this.state.nowUs = frameEndUs;
    this.state.nextTick = command.tick + 1;
    this.advanceRng();

    return Promise.resolve({
      events,
      state: this.currentState(),
      receipt: {
        requestedTick: command.tick,
        realizedTick: command.tick,
        requestedDeltaUs: command.deltaUs,
        realizedDeltaUs: command.deltaUs,
        appliedInputOrders: command.inputs.map((input) => input.order),
      },
    });
  }

  snapshot(): Promise<{ readonly snapshot: EnvironmentSnapshot }> {
    this.assertNotDisposed();
    return Promise.resolve({
      snapshot: {
        state: this.currentState(),
        runtimeState: {
          nowUs: this.state.nowUs,
          nextTick: this.state.nextTick,
        },
        rngState: {
          state: this.state.rngState,
        },
        pendingEffects: {
          receiverInitializationPending:
            this.state.receiverInitializationPending,
        },
      },
    });
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return Promise.resolve();
  }

  private handleInput(
    command: FrameCommand,
    input: RuntimeInput,
    events: V01EnvironmentEventDraft[],
  ): void {
    if (
      input.action !== INTERACT_SWITCH_ACTION ||
      input.target !== SWITCH_TARGET
    ) {
      events.push({
        kind: "log",
        localId: `mock:${command.tick}:input:${input.order}:unsupported`,
        causedByLocalId: input.localId,
        level: "warn",
        source: "mock-game",
        message: "Unsupported input ignored",
        fields: {
          action: input.action,
          target: input.target ?? null,
        },
      });
      return;
    }

    if (this.state.switchActive) {
      events.push({
        kind: "log",
        localId: `mock:${command.tick}:input:${input.order}:already-active`,
        causedByLocalId: input.localId,
        level: "debug",
        source: SWITCH_TARGET,
        message: "Switch interaction ignored because it is already active",
        fields: {},
      });
      return;
    }

    this.state.switchActive = true;
    const propertyLocalId = `mock:${command.tick}:switch.active`;
    const signalLocalId = `mock:${command.tick}:switch.activated`;
    const deliveryLocalId = `mock:${command.tick}:switch.delivery`;

    events.push({
      kind: "property_changed",
      localId: propertyLocalId,
      causedByLocalId: input.localId,
      path: SWITCH_ACTIVE_PATH,
      before: false,
      after: true,
    });
    events.push({
      kind: "signal",
      localId: signalLocalId,
      causedByLocalId: propertyLocalId,
      source: SWITCH_TARGET,
      name: SWITCH_ACTIVATED_SIGNAL,
      arguments: [],
    });

    if (!this.state.receiverConnected) {
      events.push({
        kind: "signal_delivery",
        localId: deliveryLocalId,
        causedByLocalId: signalLocalId,
        source: SWITCH_TARGET,
        name: SWITCH_ACTIVATED_SIGNAL,
        receiver: DOOR_SIGNAL_RECEIVER,
        delivered: false,
        failureReason: "receiver_not_connected",
      });
      return;
    }

    events.push({
      kind: "signal_delivery",
      localId: deliveryLocalId,
      causedByLocalId: signalLocalId,
      source: SWITCH_TARGET,
      name: SWITCH_ACTIVATED_SIGNAL,
      receiver: DOOR_SIGNAL_RECEIVER,
      delivered: true,
    });
    this.state.doorOpen = true;
    events.push({
      kind: "property_changed",
      localId: `mock:${command.tick}:door.open`,
      causedByLocalId: deliveryLocalId,
      path: DOOR_OPEN_PATH,
      before: false,
      after: true,
    });
  }

  private finishReceiverInitialization(
    tick: number,
    events: V01EnvironmentEventDraft[],
  ): void {
    if (!this.state.receiverInitializationPending) return;

    this.state.receiverInitializationPending = false;
    this.state.receiverConnected = true;
    events.push({
      kind: "property_changed",
      localId: `mock:${tick}:door.receiver_connected`,
      path: DOOR_RECEIVER_CONNECTED_PATH,
      before: false,
      after: true,
    });
  }

  private currentState(): StateSnapshot {
    return makeStateSnapshot(
      this.state.switchActive,
      this.state.doorOpen,
      this.state.receiverConnected,
    );
  }

  private assertFrameCommand(command: FrameCommand): void {
    if (command.tick !== this.state.nextTick) {
      throw new Error(
        `Expected tick ${this.state.nextTick}, received ${command.tick}`,
      );
    }
    if (command.simTimeUs !== this.state.nowUs) {
      throw new Error(
        `Expected simTimeUs ${this.state.nowUs}, received ${command.simTimeUs}`,
      );
    }
    if (!Number.isSafeInteger(command.deltaUs) || command.deltaUs <= 0) {
      throw new RangeError("deltaUs must be a positive safe integer");
    }
  }

  private advanceRng(): void {
    let value = this.state.rngState | 0;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state.rngState = value >>> 0;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("Mock game environment has been disposed");
    }
  }
}

export class MockGameEnvironmentFactory implements GameEnvironmentFactoryPort {
  create(request: GameEnvironmentLaunchRequest): Promise<GameEnvironmentPort> {
    const { environment } = request;
    if (
      environment.adapter !== MOCK_GAME_ENVIRONMENT_REF.adapter ||
      environment.adapterVersion !== MOCK_GAME_ENVIRONMENT_REF.adapterVersion ||
      environment.scene !== MOCK_GAME_ENVIRONMENT_REF.scene
    ) {
      throw new Error(
        `Unsupported mock environment: ${environment.adapter}@${environment.adapterVersion}/${environment.scene}`,
      );
    }

    return Promise.resolve(new MockGameEnvironment());
  }
}
