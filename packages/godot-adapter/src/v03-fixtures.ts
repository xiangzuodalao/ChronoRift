import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  CheckpointCertificateV1Schema,
  EnvironmentRefSchema,
  EnvironmentSnapshotSchema,
  RuntimeFingerprintV1Schema,
  asBranchId,
  asCheckpointId,
  asExecutionId,
  asFixtureId,
  asInterventionId,
  asRunId,
  type CheckpointCertificateV1,
  type EnvironmentRef,
  type EnvironmentSnapshot,
  type FixtureId,
  type JsonValue,
  type RuntimeFingerprintV1,
} from "@chronorift/domain";
import {
  v03InputTraceIdFor,
  type V03BenchmarkOracle,
  type V03FixtureDefinition,
} from "@chronorift/gamebranch";
import { payloadHash } from "@chronorift/godot-protocol";

import {
  GODOT_ADAPTER,
  GODOT_ADAPTER_VERSION,
  GODOT_CAPABILITIES,
  fingerprintGodotSourceTrees,
  stageGodotProject,
  type PreparedGodotFixture,
  type PrepareGodotFixtureOptions,
} from "./fixture.js";
import { doctorGodot } from "./installer.js";
import { GodotGameEnvironmentFactory } from "./godot-environment.js";

export const V03_FIXTURE_IDS = Object.freeze([
  "signal-ordering",
  "frame-input-window",
  "physics-tunneling",
  "entity-reuse",
] as const);

export type V03FixtureName = (typeof V03_FIXTURE_IDS)[number];

export const V03_FIXTURE_CASE_IDS: Readonly<Record<V03FixtureName, string>> =
  Object.freeze({
    "signal-ordering": "godot-runtime-case-01",
    "frame-input-window": "godot-runtime-case-02",
    "physics-tunneling": "godot-runtime-case-03",
    "entity-reuse": "godot-runtime-case-04",
  });

interface FixtureBlueprint {
  readonly name: V03FixtureName;
  readonly fixtureId: FixtureId;
  readonly directory: string;
  readonly scene: string;
  readonly trigger: { readonly source: string; readonly name: string };
  readonly expectation: { readonly path: string; readonly value: JsonValue };
  readonly withinTicks: number;
  readonly participantId: string;
  readonly participantState: JsonValue;
  readonly stateValues: Readonly<Record<string, JsonValue>>;
  readonly inputs: V03FixtureDefinition["inputTrace"]["inputs"];
  readonly controls: V03FixtureDefinition["baselineControls"];
  readonly probeProperties: readonly string[];
  readonly experiments: V03FixtureDefinition["experiments"];
  readonly fixtureControlDefaults: V03FixtureDefinition["fixtureControlDefaults"];
  readonly coverage: readonly string[];
  readonly oracle: Omit<V03BenchmarkOracle, "fixtureId">;
}

const experiment = (
  caseId: string,
  suffix: string,
  label: string,
  intervention: V03FixtureDefinition["experiments"][number]["intervention"],
): V03FixtureDefinition["experiments"][number] => ({
  schemaVersion: 1,
  interventionId: asInterventionId(
    `intervention:v03:${createHash("sha256")
      .update(`${caseId}\0${suffix}`)
      .digest("hex")
      .slice(0, 24)}`,
  ),
  label,
  intervention,
});

const blueprints: Readonly<Record<V03FixtureName, FixtureBlueprint>> = {
  "signal-ordering": {
    name: "signal-ordering",
    fixtureId: asFixtureId(V03_FIXTURE_CASE_IDS["signal-ordering"]),
    directory: "godot-switch-door",
    scene: "switch-door-signal-ordering",
    trigger: { source: "switch", name: "switch.activated" },
    expectation: { path: "door.open", value: true },
    withinTicks: 1,
    participantId: "switch-door",
    participantState: {
      switchActive: false,
      doorOpen: false,
      receiverConnected: false,
      initializationPending: true,
    },
    stateValues: {
      "switch.active": false,
      "door.open": false,
      "door.receiver_connected": false,
    },
    inputs: [
      {
        scheduleBasis: "relative_tick",
        relativeTick: 0,
        order: 0,
        action: "interact_switch",
        target: "switch",
        payload: {},
      },
    ],
    controls: { deltaUs: 16_667, maxTicks: 2, variables: {} },
    probeProperties: ["switch.active", "door.open", "door.receiver_connected"],
    experiments: [
      experiment(
        "case-01",
        "input-plus-one",
        "Shift input by one logical tick",
        {
          kind: "shift_input",
          inputOrder: 0,
          deltaTicks: 1,
        },
      ),
      experiment("case-01", "fixed-fps-120", "Run at 120 fixed FPS", {
        kind: "set_runtime_control",
        name: "fixed_fps",
        value: 120,
      }),
    ],
    fixtureControlDefaults: {},
    coverage: [
      "fixture.switch_state",
      "fixture.door_state",
      "fixture.signal_connections",
    ],
    oracle: {
      mechanismCode: "signal_before_receiver_connection",
      sourcePath: "door.gd",
      sourceSymbol: "_process",
    },
  },
  "frame-input-window": {
    name: "frame-input-window",
    fixtureId: asFixtureId(V03_FIXTURE_CASE_IDS["frame-input-window"]),
    directory: "godot-frame-input-window",
    scene: "frame-input-window",
    trigger: { source: "player", name: "player.left_ledge" },
    expectation: { path: "player.jumping", value: true },
    withinTicks: 10,
    participantId: "case-02-state",
    participantState: {
      started: false,
      jumping: false,
      leftFrame: -1,
      processCallbacks: 0,
    },
    stateValues: {
      "player.jumping": false,
      "player.window_open": false,
      "player.process_callbacks": 0,
    },
    inputs: [
      {
        scheduleBasis: "relative_sim_time_us",
        relativeTimeUs: 75_000,
        order: 0,
        action: "attempt_jump",
        target: "player",
        payload: {},
      },
    ],
    controls: {
      deltaUs: 8_333,
      maxTicks: 10,
      variables: { fixed_fps: 120 },
    },
    probeProperties: [
      "player.jumping",
      "player.window_open",
      "player.process_callbacks",
    ],
    experiments: [
      experiment("case-02", "physics-120", "Run physics at 120 TPS", {
        kind: "set_runtime_control",
        name: "physics_ticks_per_second",
        value: 120,
      }),
      experiment("case-02", "fixed-fps-60", "Run at 60 fixed FPS", {
        kind: "set_runtime_control",
        name: "fixed_fps",
        value: 60,
      }),
    ],
    fixtureControlDefaults: {},
    coverage: ["fixture.player_state", "input_schedule", "process_frame_clock"],
    oracle: {
      mechanismCode: "frame_count_used_for_time_window",
      sourcePath: "frame_input_window.gd",
      sourceSymbol: "_process",
    },
  },
  "physics-tunneling": {
    name: "physics-tunneling",
    fixtureId: asFixtureId(V03_FIXTURE_CASE_IDS["physics-tunneling"]),
    directory: "godot-physics-tunneling",
    scene: "physics-tunneling",
    trigger: { source: "projectile", name: "projectile.fired" },
    expectation: { path: "target.hit", value: true },
    withinTicks: 3,
    participantId: "case-03-state",
    participantState: {
      fired: false,
      fireEventAnchor: "",
      projectileX: 0.0,
      targetHit: false,
    },
    stateValues: { "projectile.x": 0, "target.hit": false },
    inputs: [
      {
        scheduleBasis: "relative_tick",
        relativeTick: 0,
        order: 0,
        action: "fire_projectile",
        target: "projectile",
        payload: {},
      },
    ],
    controls: {
      deltaUs: 33_333,
      maxTicks: 4,
      variables: { fixed_fps: 30, physics_ticks_per_second: 30 },
    },
    probeProperties: ["projectile.x", "target.hit"],
    experiments: [
      experiment("case-03", "fixed-fps-120", "Run at 120 fixed FPS", {
        kind: "set_runtime_control",
        name: "fixed_fps",
        value: 120,
      }),
      experiment("case-03", "physics-120", "Run physics at 120 TPS", {
        kind: "set_runtime_control",
        name: "physics_ticks_per_second",
        value: 120,
      }),
    ],
    fixtureControlDefaults: {},
    coverage: [
      "fixture.projectile_state",
      "fixture.target_state",
      "physics_tick_clock",
    ],
    oracle: {
      mechanismCode: "discrete_physics_tunneling",
      sourcePath: "physics_tunneling.gd",
      sourceSymbol: "_physics_process",
    },
  },
  "entity-reuse": {
    name: "entity-reuse",
    fixtureId: asFixtureId(V03_FIXTURE_CASE_IDS["entity-reuse"]),
    directory: "godot-entity-reuse",
    scene: "entity-reuse",
    trigger: { source: "enemy", name: "enemy.respawned" },
    expectation: { path: "enemy.health", value: 100 },
    withinTicks: 2,
    participantId: "case-04-state",
    participantState: {
      health: 100,
      generation: 1,
      effectSequence: 0,
      pendingEffects: [],
      lastProcessedTick: -1,
    },
    stateValues: {
      "enemy.health": 100,
      "enemy.incarnation": 1,
      "enemy.effect_sequence": 0,
      "enemy.pending_effect_count": 0,
      "control.pooling_enabled": true,
    },
    inputs: [
      {
        scheduleBasis: "relative_tick",
        relativeTick: 0,
        order: 0,
        action: "recycle_enemy",
        target: "enemy",
        payload: {},
      },
    ],
    controls: { deltaUs: 16_667, maxTicks: 3, variables: {} },
    probeProperties: [
      "enemy.health",
      "enemy.incarnation",
      "enemy.effect_sequence",
      "enemy.pending_effect_count",
      "control.pooling_enabled",
    ],
    experiments: [
      experiment("case-04", "fixed-fps-120", "Run at 120 fixed FPS", {
        kind: "set_runtime_control",
        name: "fixed_fps",
        value: 120,
      }),
      experiment("case-04", "pooling-off", "Disable instance pooling", {
        kind: "set_fixture_control",
        name: "pooling_enabled",
        value: false,
      }),
    ],
    fixtureControlDefaults: { pooling_enabled: true },
    coverage: [
      "fixture.enemy_state",
      "fixture.entity_incarnation",
      "pending_effects",
    ],
    oracle: {
      mechanismCode: "stale_effect_crossed_entity_incarnation",
      sourcePath: "entity_reuse.gd",
      sourceSymbol: "_resolve_pending_effect",
    },
  },
};

const platformName = (): string => {
  if (process.platform === "linux") return "Linux";
  if (process.platform === "darwin") return "macOS";
  if (process.platform === "win32") return "Windows";
  return process.platform;
};

export interface PreparedV03GodotFixture extends PreparedGodotFixture {
  readonly fixtureName: V03FixtureName;
  readonly fixture: V03FixtureDefinition;
  readonly oracle: V03BenchmarkOracle;
  readonly sourceDirectory: string;
}

export const asV03FixtureName = (value: string): V03FixtureName => {
  if (!V03_FIXTURE_IDS.includes(value as V03FixtureName)) {
    throw new Error(
      `Unsupported Fixture ${value}; expected ${V03_FIXTURE_IDS.join(", ")}`,
    );
  }
  return value as V03FixtureName;
};

export const v03FixtureNameForId = (value: string): V03FixtureName => {
  const entry = Object.entries(V03_FIXTURE_CASE_IDS).find(
    ([, fixtureId]) => fixtureId === value,
  );
  if (entry === undefined) throw new Error(`Unknown v0.3 Fixture ID ${value}`);
  return entry[0] as V03FixtureName;
};

interface ObservedInitialCheckpoint {
  readonly environment: EnvironmentRef;
  readonly snapshot: EnvironmentSnapshot;
  readonly certificate: CheckpointCertificateV1;
}

const initialCheckpointCaptures = new Map<
  string,
  Promise<ObservedInitialCheckpoint>
>();

const jsonRecord = (
  value: JsonValue,
): Readonly<Record<string, JsonValue>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;

export const observedCheckpointValidationMatchesSnapshot = (
  snapshot: EnvironmentSnapshot,
  certificate: CheckpointCertificateV1,
): boolean => {
  const runtimeState = jsonRecord(snapshot.runtimeState);
  const participants =
    runtimeState === undefined
      ? undefined
      : jsonRecord(runtimeState["participants"] ?? null);
  if (participants === undefined) return false;
  const participantIds = Object.keys(participants).sort();
  const validations = certificate.restoreValidation;
  if (
    participantIds.length === 0 ||
    validations.length !== participantIds.length ||
    new Set(validations.map((entry) => entry.participantId)).size !==
      validations.length
  ) {
    return false;
  }
  return participantIds.every((participantId) => {
    const validation = validations.find(
      (entry) => entry.participantId === participantId,
    );
    const state = participants[participantId];
    return (
      validation?.status === "pass" &&
      state !== undefined &&
      validation.stateHash === payloadHash(state) &&
      certificate.coveredStateDomains.includes(`participant.${participantId}`)
    );
  });
};

const captureInitialCheckpoint = async (options: {
  readonly cacheKey: string;
  readonly binary: string;
  readonly projectDirectory: string;
  readonly runtimeRoot: string;
  readonly environment: EnvironmentRef;
  readonly fingerprint: RuntimeFingerprintV1;
  readonly blueprint: FixtureBlueprint;
  readonly expectedSnapshot: EnvironmentSnapshot;
}): Promise<ObservedInitialCheckpoint> => {
  const existing = initialCheckpointCaptures.get(options.cacheKey);
  if (existing !== undefined) return structuredClone(await existing);
  const pending = (async (): Promise<ObservedInitialCheckpoint> => {
    const factory = new GodotGameEnvironmentFactory({
      binary: options.binary,
      projectDirectory: options.projectDirectory,
      runtimeRoot: options.runtimeRoot,
    });
    const environment = await factory.create({
      environment: options.environment,
      runId: asRunId(`run:v03:capture:${options.blueprint.fixtureId}`),
      branchId: asBranchId(`branch:v03:capture:${options.blueprint.fixtureId}`),
      executionId: asExecutionId(
        `execution:v03:capture:${options.blueprint.fixtureId}`,
      ),
      controls: options.blueprint.controls,
      requiredCapabilities: options.fingerprint.capabilities,
      probePlan: {
        schemaVersion: 1,
        signals: [options.blueprint.trigger],
        properties: options.blueprint.probeProperties,
      },
    });
    try {
      const captured = await environment.snapshot();
      if (
        payloadHash(captured.snapshot as unknown as JsonValue) !==
        payloadHash(options.expectedSnapshot as unknown as JsonValue)
      ) {
        throw new Error(
          `Godot initial capture differs from the frozen ${options.blueprint.name} blueprint`,
        );
      }
      const certificate = captured.certificate;
      if (
        certificate === undefined ||
        certificate.level !== "fixture_semantic_l2" ||
        certificate.captureConsistencyModel !== "frame_end_barrier" ||
        certificate.adapterSemanticBarrier !==
          "chronorift.frame_end_deferred" ||
        certificate.restoreRecipeHash !==
          payloadHash(captured.snapshot as unknown as JsonValue) ||
        certificate.restoreValidation.length === 0 ||
        certificate.restoreValidation.some(
          (validation) => validation.status !== "pass",
        ) ||
        !observedCheckpointValidationMatchesSnapshot(
          captured.snapshot,
          certificate,
        )
      ) {
        throw new Error(
          `Godot did not return an admissible observed checkpoint for ${options.blueprint.name}`,
        );
      }
      return {
        environment: EnvironmentRefSchema.parse(environment.descriptor),
        snapshot: captured.snapshot,
        certificate,
      };
    } finally {
      await environment.dispose();
    }
  })();
  initialCheckpointCaptures.set(options.cacheKey, pending);
  try {
    return structuredClone(await pending);
  } catch (error) {
    if (initialCheckpointCaptures.get(options.cacheKey) === pending) {
      initialCheckpointCaptures.delete(options.cacheKey);
    }
    throw error;
  }
};

export const prepareV03GodotFixture = async (
  fixtureName: V03FixtureName,
  options: PrepareGodotFixtureOptions,
): Promise<PreparedV03GodotFixture> => {
  if (
    options.checkpointLevel !== undefined &&
    options.checkpointLevel !== "fixture_semantic_l2"
  ) {
    throw new Error(
      "ChronoRift v0.3 requires an observed fixture_semantic_l2 checkpoint",
    );
  }
  const blueprint = blueprints[fixtureName];
  const cwd = resolve(options.cwd);
  const artifactRoot = resolve(options.artifactRoot);
  const addonSource = resolve(cwd, "godot/addons/chronorift");
  const fixtureSource = resolve(cwd, "fixtures", blueprint.directory);
  for (const source of [addonSource, fixtureSource]) {
    if (!(await stat(source)).isDirectory())
      throw new Error(`Missing source: ${source}`);
  }
  const [sourceFingerprint, doctor] = await Promise.all([
    fingerprintGodotSourceTrees({ fixtureSource, addonSource }),
    doctorGodot({
      cwd,
      ...(options.godotBin === undefined ? {} : { godotBin: options.godotBin }),
    }),
  ]);
  const { addonHash, projectHash } = sourceFingerprint;
  const projectDirectory = await stageGodotProject({
    artifactRoot,
    directoryName: `${fixtureName}-${projectHash.slice(0, 16)}`,
    fixtureSource,
    addonSource,
    projectHash,
    addonHash,
  });
  const defaultFixedFps =
    typeof blueprint.controls.variables["fixed_fps"] === "number"
      ? blueprint.controls.variables["fixed_fps"]
      : 60;
  const defaultPhysicsTps =
    typeof blueprint.controls.variables["physics_ticks_per_second"] === "number"
      ? blueprint.controls.variables["physics_ticks_per_second"]
      : 60;
  const fingerprint: RuntimeFingerprintV1 = RuntimeFingerprintV1Schema.parse({
    schemaVersion: 1,
    engine: "godot",
    engineVersion: "4.7.1-stable (official)",
    adapterVersion: GODOT_ADAPTER_VERSION,
    protocolVersion: 2,
    platform: platformName(),
    renderer: "gl_compatibility",
    physicsTicksPerSecond: defaultPhysicsTps,
    fixedFps: defaultFixedFps,
    projectHash,
    addonHash,
    capabilities: GODOT_CAPABILITIES,
  });
  const fixtureId = blueprint.fixtureId;
  const environment: EnvironmentRef = EnvironmentRefSchema.parse({
    adapter: GODOT_ADAPTER,
    adapterVersion: GODOT_ADAPTER_VERSION,
    scene: blueprint.scene,
    build: `godot:${doctor.version}:${projectHash}`,
    runtimeFingerprint: fingerprint,
  });
  const stateValues = {
    ...blueprint.stateValues,
    ...Object.fromEntries(
      Object.entries(blueprint.fixtureControlDefaults).map(([name, value]) => [
        `control.${name}`,
        value,
      ]),
    ),
  };
  const expectedSnapshot: EnvironmentSnapshot = EnvironmentSnapshotSchema.parse(
    {
      state: { values: stateValues },
      runtimeState: {
        nowUs: 0,
        nextTick: 0,
        participants: { [blueprint.participantId]: blueprint.participantState },
      },
      rngState: {},
      pendingEffects:
        blueprint.name === "entity-reuse"
          ? {
              deferredCallsDrained: false,
              participants: {
                [blueprint.participantId]: {
                  effectSequence: 0,
                  pendingEffects: [],
                },
              },
            }
          : { deferredCallsDrained: false, participants: {} },
    },
  );
  const observedCheckpoint = await captureInitialCheckpoint({
    cacheKey: `${projectDirectory}\0${defaultFixedFps}\0${defaultPhysicsTps}`,
    binary: doctor.binary,
    projectDirectory,
    runtimeRoot: resolve(artifactRoot, "godot-capture-runtime"),
    environment,
    fingerprint,
    blueprint,
    expectedSnapshot,
  });
  const snapshot = observedCheckpoint.snapshot;
  const certificate = CheckpointCertificateV1Schema.parse(
    observedCheckpoint.certificate,
  );
  const observedEnvironment = observedCheckpoint.environment;
  const traceWithoutId = {
    schemaVersion: 2 as const,
    inputs: blueprint.inputs,
  };
  const fixture: V03FixtureDefinition = {
    fixtureId,
    contractInput: {
      schemaVersion: 2,
      fixtureId,
      authority: {
        status: "frozen",
        approvedBy: `chronorift.fixture.${fixtureId}.v0.3`,
      },
      rule: {
        trigger: { kind: "signal", ...blueprint.trigger },
        expectation: {
          kind: "property_equals",
          ...blueprint.expectation,
        },
        withinTicks: blueprint.withinTicks,
        inclusive: true,
      },
    },
    initialCheckpointContent: {
      schemaVersion: 1,
      environment: observedEnvironment,
      nextTick: 0,
      simTimeUs: 0,
      snapshot,
      certificate,
    },
    inputTrace: {
      ...traceWithoutId,
      inputTraceId: v03InputTraceIdFor(traceWithoutId),
    },
    baselineControls: blueprint.controls,
    probeProperties: blueprint.probeProperties,
    experiments: blueprint.experiments,
    fixtureControlDefaults: blueprint.fixtureControlDefaults,
    checkpointLimitations: certificate.limitations,
  };
  const checkpointId = asCheckpointId(
    `checkpoint:godot:v03:${payloadHash(fixture.initialCheckpointContent as unknown as JsonValue)}`,
  );
  return {
    fixtureName,
    projectDirectory,
    sourceDirectory: fixtureSource,
    addonHash,
    projectHash,
    doctor,
    environment: observedEnvironment,
    initialCheckpointContent: fixture.initialCheckpointContent,
    checkpointId,
    fixture,
    oracle: { fixtureId, ...blueprint.oracle },
  };
};
