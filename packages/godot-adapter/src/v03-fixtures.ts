import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import {
  CheckpointCertificateV1Schema,
  EnvironmentRefSchema,
  EnvironmentSnapshotSchema,
  RuntimeFingerprintV1Schema,
  asCheckpointId,
  asFixtureId,
  asInterventionId,
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
  type PreparedGodotFixture,
  type PrepareGodotFixtureOptions,
} from "./fixture.js";
import { doctorGodot } from "./installer.js";

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
  interventionId: asInterventionId(`intervention:${caseId}:${suffix}`),
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
    withinTicks: 8,
    participantId: "case-02-state",
    participantState: { started: false, jumping: false, leftFrame: -1 },
    stateValues: { "player.jumping": false, "player.window_open": false },
    inputs: [
      {
        scheduleBasis: "relative_sim_time_us",
        relativeTimeUs: 50_000,
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
    probeProperties: ["player.jumping", "player.window_open"],
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
    participantState: { fired: false, projectileX: 0.0, targetHit: false },
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
      deltaUs: 16_667,
      maxTicks: 4,
      variables: { physics_ticks_per_second: 30 },
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
    participantState: { health: 100, generation: 1 },
    stateValues: {
      "enemy.health": 100,
      "enemy.incarnation": 1,
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
      sourceSymbol: "_recycle_enemy",
    },
  },
};

const assertContained = (parent: string, child: string): void => {
  const path = relative(parent, child);
  if (path === "" || path === ".") return;
  if (path === ".." || path.startsWith(`..${sep}`) || path.startsWith(sep)) {
    throw new Error(`Path escapes expected root: ${child}`);
  }
};

const collectFiles = async (root: string): Promise<readonly string[]> => {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    assertContained(root, directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink())
        throw new Error(`Symlink rejected: ${path}`);
      if (metadata.isDirectory()) await visit(path);
      else if (metadata.isFile()) files.push(path);
    }
  };
  await visit(root);
  return files.sort();
};

const hashTree = async (root: string): Promise<string> => {
  const hash = createHash("sha256");
  for (const path of await collectFiles(root)) {
    hash.update(relative(root, path).split(sep).join("/"));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
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

export const prepareV03GodotFixture = async (
  fixtureName: V03FixtureName,
  options: PrepareGodotFixtureOptions,
): Promise<PreparedV03GodotFixture> => {
  const blueprint = blueprints[fixtureName];
  const cwd = resolve(options.cwd);
  const artifactRoot = resolve(options.artifactRoot);
  const addonSource = resolve(cwd, "godot/addons/chronorift");
  const fixtureSource = resolve(cwd, "fixtures", blueprint.directory);
  for (const source of [addonSource, fixtureSource]) {
    if (!(await stat(source)).isDirectory())
      throw new Error(`Missing source: ${source}`);
  }
  const [addonHash, fixtureHash, doctor] = await Promise.all([
    hashTree(addonSource),
    hashTree(fixtureSource),
    doctorGodot({
      cwd,
      ...(options.godotBin === undefined ? {} : { godotBin: options.godotBin }),
    }),
  ]);
  const projectHash = createHash("sha256")
    .update(`${fixtureHash}\0${addonHash}`)
    .digest("hex");
  const projectDirectory = resolve(
    artifactRoot,
    "godot-projects",
    `${fixtureName}-${projectHash.slice(0, 16)}`,
  );
  assertContained(artifactRoot, projectDirectory);
  await mkdir(projectDirectory, { recursive: true });
  await cp(fixtureSource, projectDirectory, {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
  const addonTarget = join(projectDirectory, "addons", "chronorift");
  await mkdir(join(projectDirectory, "addons"), { recursive: true });
  await cp(addonSource, addonTarget, {
    recursive: true,
    force: false,
    errorOnExist: false,
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
  const snapshot: EnvironmentSnapshot = EnvironmentSnapshotSchema.parse({
    state: { values: stateValues },
    runtimeState: {
      nowUs: 0,
      nextTick: 0,
      participants: { [blueprint.participantId]: blueprint.participantState },
    },
    rngState: {},
    pendingEffects: { deferredCallsDrained: false },
  });
  const certificate: CheckpointCertificateV1 =
    CheckpointCertificateV1Schema.parse({
      schemaVersion: 1,
      level: options.checkpointLevel ?? "fixture_semantic_l2",
      captureConsistencyModel: "frame_end_barrier",
      adapterSemanticBarrier: "chronorift.frame_end_deferred",
      environmentFingerprint: fingerprint,
      coveredStateDomains: [
        ...blueprint.coverage,
        "logical_clock",
        "input_schedule",
      ],
      missingStateDomains: [
        "godot.physics_internal",
        "godot.timers_tweens_coroutines",
        "godot.threads",
        "godot.unregistered_rng",
        "godot.resource_caches",
        "external_services",
      ],
      externalDependencies: [],
      rngDomains: [],
      pendingAsyncOperations: ["untracked_deferred_calls"],
      restoreRecipeHash: payloadHash(snapshot as unknown as JsonValue),
      restoreValidation: [
        {
          participantId: blueprint.participantId,
          status: "pass",
          stateHash: payloadHash(blueprint.participantState),
          message: "Initial Fixture participant state is canonical",
        },
      ],
      portability: "same_build_only",
      limitations: [
        `Only registered participant ${blueprint.participantId} is restored`,
        "Godot engine internals are not checkpointed",
      ],
    });
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
      environment,
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
    environment,
    initialCheckpointContent: fixture.initialCheckpointContent,
    checkpointId,
    fixture,
    oracle: { fixtureId, ...blueprint.oracle },
  };
};
