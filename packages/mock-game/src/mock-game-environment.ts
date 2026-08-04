import {
  EnvironmentSnapshotSchema,
  type EnvironmentEventDraft,
  type EnvironmentRef,
  type EnvironmentSnapshot,
  type JsonObject,
  type JsonValue,
  type StateSnapshot,
} from "@chronorift/domain";
import type {
  FrameCommand,
  FrameObservation,
  GameEnvironmentFactoryPort,
  GameEnvironmentPort,
  RuntimeInput,
} from "@chronorift/gamebranch";

import {
  DOOR_OPEN_DELAY_US,
  DOOR_OPEN_PATH,
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
  build: "phase-1",
});

interface PendingDoorTimer {
  readonly openAtUs: number;
  readonly scheduledTick: number;
  readonly causedByLocalId: string;
}

interface MutableRuntimeState {
  nowUs: number;
  nextTick: number;
  switchActive: boolean;
  doorOpen: boolean;
  pendingDoorTimer: PendingDoorTimer | null;
  rngState: number;
}

const INITIAL_RUNTIME_STATE: Readonly<MutableRuntimeState> = Object.freeze({
  nowUs: 0,
  nextTick: 0,
  switchActive: false,
  doorOpen: false,
  pendingDoorTimer: null,
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

const expectString = (value: JsonValue, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
};

const readState = (
  snapshot: StateSnapshot,
): Pick<MutableRuntimeState, "switchActive" | "doorOpen"> => ({
  switchActive: expectBoolean(
    snapshot.values[SWITCH_ACTIVE_PATH] ?? null,
    `state.${SWITCH_ACTIVE_PATH}`,
  ),
  doorOpen: expectBoolean(
    snapshot.values[DOOR_OPEN_PATH] ?? null,
    `state.${DOOR_OPEN_PATH}`,
  ),
});

const readPendingDoorTimer = (
  pendingEffects: JsonValue,
): PendingDoorTimer | null => {
  const value = expectObject(pendingEffects, "pendingEffects").doorTimer;
  if (value === null) {
    return null;
  }
  const timer = expectObject(value ?? null, "pendingEffects.doorTimer");
  return {
    openAtUs: expectNonNegativeInteger(
      timer.openAtUs ?? null,
      "pendingEffects.doorTimer.openAtUs",
    ),
    scheduledTick: expectNonNegativeInteger(
      timer.scheduledTick ?? null,
      "pendingEffects.doorTimer.scheduledTick",
    ),
    causedByLocalId: expectString(
      timer.causedByLocalId ?? null,
      "pendingEffects.doorTimer.causedByLocalId",
    ),
  };
};

const copyDescriptor = (): EnvironmentRef => ({
  ...MOCK_GAME_ENVIRONMENT_REF,
});

const makeStateSnapshot = (
  switchActive: boolean,
  doorOpen: boolean,
): StateSnapshot => ({
  values: {
    [SWITCH_ACTIVE_PATH]: switchActive,
    [DOOR_OPEN_PATH]: doorOpen,
  },
});

export const createInitialMockSnapshot = (): EnvironmentSnapshot => ({
  state: makeStateSnapshot(false, false),
  runtimeState: {
    nowUs: INITIAL_RUNTIME_STATE.nowUs,
    nextTick: INITIAL_RUNTIME_STATE.nextTick,
  },
  rngState: {
    state: INITIAL_RUNTIME_STATE.rngState,
  },
  pendingEffects: {
    doorTimer: null,
  },
});

/**
 * A deterministic in-process game with one intentional timing defect.
 *
 * Inputs are handled at frame start. Timers are checked at frame end, so a
 * 16,000 us delta reaches the 32,000 us deadline in two frames while 16,667
 * us skips from 16,667 to 33,334 us.
 */
export class MockGameEnvironment implements GameEnvironmentPort {
  readonly descriptor: EnvironmentRef = copyDescriptor();

  private state: MutableRuntimeState = { ...INITIAL_RUNTIME_STATE };
  private disposed = false;

  restore(snapshot: EnvironmentSnapshot): Promise<void> {
    this.assertNotDisposed();
    const parsed = EnvironmentSnapshotSchema.parse(snapshot);
    const runtime = expectObject(parsed.runtimeState, "runtimeState");
    const rng = expectObject(parsed.rngState, "rngState");
    const state = readState(parsed.state);

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
      pendingDoorTimer: readPendingDoorTimer(parsed.pendingEffects),
      rngState: expectNonNegativeInteger(rng.state ?? null, "rngState.state"),
    };
    return Promise.resolve();
  }

  step(command: FrameCommand): Promise<FrameObservation> {
    this.assertNotDisposed();
    this.assertFrameCommand(command);

    const events: EnvironmentEventDraft[] = [];
    const seenInputIds = new Set<string>();

    for (const input of command.inputs) {
      if (seenInputIds.has(input.localId)) {
        throw new Error(`Duplicate runtime input localId: ${input.localId}`);
      }
      seenInputIds.add(input.localId);
      this.handleInput(command, input, events);
    }

    const frameEndUs = command.simTimeUs + command.deltaUs;
    if (!Number.isSafeInteger(frameEndUs)) {
      throw new RangeError("Frame end time exceeds the safe integer range");
    }

    this.state.nowUs = frameEndUs;
    this.checkDoorTimer(command.tick, events);
    this.state.nextTick = command.tick + 1;
    this.advanceRng();

    return Promise.resolve({
      events,
      state: makeStateSnapshot(this.state.switchActive, this.state.doorOpen),
    });
  }

  snapshot(): Promise<EnvironmentSnapshot> {
    this.assertNotDisposed();
    const timer = this.state.pendingDoorTimer;

    return Promise.resolve({
      state: makeStateSnapshot(this.state.switchActive, this.state.doorOpen),
      runtimeState: {
        nowUs: this.state.nowUs,
        nextTick: this.state.nextTick,
      },
      rngState: {
        state: this.state.rngState,
      },
      pendingEffects: {
        doorTimer:
          timer === null
            ? null
            : {
                openAtUs: timer.openAtUs,
                scheduledTick: timer.scheduledTick,
                causedByLocalId: timer.causedByLocalId,
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
    events: EnvironmentEventDraft[],
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
    const scheduleLocalId = `mock:${command.tick}:door.schedule`;

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

    const openAtUs = this.state.nowUs + DOOR_OPEN_DELAY_US;
    this.state.pendingDoorTimer = {
      openAtUs,
      scheduledTick: command.tick,
      causedByLocalId: scheduleLocalId,
    };
    events.push({
      kind: "log",
      localId: scheduleLocalId,
      causedByLocalId: signalLocalId,
      level: "debug",
      source: "door",
      message: "Door open timer scheduled",
      fields: {
        scheduledAtUs: this.state.nowUs,
        openAtUs,
        delayUs: DOOR_OPEN_DELAY_US,
      },
    });
  }

  private checkDoorTimer(tick: number, events: EnvironmentEventDraft[]): void {
    const timer = this.state.pendingDoorTimer;
    if (timer === null || this.state.doorOpen) {
      return;
    }

    const checkLocalId = `mock:${tick}:door.check`;
    const nowUs = this.state.nowUs;
    const openAtUs = timer.openAtUs;
    const deadlineMatched = nowUs === openAtUs;
    const checkEvent: EnvironmentEventDraft = {
      kind: "log",
      localId: checkLocalId,
      level: "debug",
      source: "door",
      message: "Door open timer checked",
      fields: {
        nowUs,
        openAtUs,
        deadlineMatched,
      },
      ...(timer.scheduledTick === tick
        ? { causedByLocalId: timer.causedByLocalId }
        : {}),
    };
    events.push(checkEvent);

    // Intentional Phase 1 bug: a discrete frame can step over the deadline.
    if (nowUs === openAtUs) {
      this.state.doorOpen = true;
      this.state.pendingDoorTimer = null;
      events.push({
        kind: "property_changed",
        localId: `mock:${tick}:door.open`,
        causedByLocalId: checkLocalId,
        path: DOOR_OPEN_PATH,
        before: false,
        after: true,
      });
    }
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
  create(environment: EnvironmentRef): Promise<GameEnvironmentPort> {
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
