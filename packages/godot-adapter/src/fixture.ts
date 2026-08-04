import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

import {
  CheckpointCertificateV1Schema,
  EnvironmentRefSchema,
  EnvironmentSnapshotSchema,
  RuntimeFingerprintV1Schema,
  asCheckpointId,
  type CheckpointCertificateV1,
  type CheckpointContent,
  type EnvironmentRef,
  type EnvironmentSnapshot,
  type JsonValue,
  type RuntimeFingerprintV1,
} from "@chronorift/domain";
import { payloadHash } from "@chronorift/godot-protocol";

import { doctorGodot, type GodotDoctorReport } from "./installer.js";

export const GODOT_ADAPTER = "chronorift.godot";
export const GODOT_ADAPTER_VERSION = "0.3.0";
export const GODOT_FIXTURE_SCENE = "switch-door-signal-ordering";
export const GODOT_FIXED_FPS = 60;

export const GODOT_CAPABILITIES = Object.freeze([
  "observe.signal_allowlist",
  "observe.property_sampling",
  "control.input_event_action",
  "clock.process_frame",
  "clock.physics_tick",
  "launch.fixed_fps",
  "checkpoint.l0_restart",
  "checkpoint.fixture_semantic",
  "observe.entity_lifecycle",
  "observe.pending_effect",
  "observe.dynamic_property_registry",
  "control.physics_ticks_per_second",
  "control.fixture_allowlist",
] as const);

const requiredCoverage = Object.freeze([
  "fixture.switch_state",
  "fixture.door_state",
  "fixture.signal_connections",
  "logical_clock",
  "input_schedule",
]);

const missingDomains = Object.freeze([
  "godot.physics_internal",
  "godot.timers_tweens_coroutines",
  "godot.threads",
  "godot.unregistered_rng",
  "godot.resource_caches",
  "external_services",
]);

const assertContained = (parent: string, child: string): void => {
  const path = relative(parent, child);
  if (path === "" || path === ".") return;
  if (path.startsWith(`..${sep}`) || path === ".." || path.startsWith(sep)) {
    throw new Error(`Path escapes its expected root: ${child}`);
  }
};

const collectFiles = async (
  root: string,
  ignoredRootDirectories: ReadonlySet<string> = new Set(),
): Promise<readonly string[]> => {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    assertContained(root, directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(
          `ChronoRift source trees may not contain symlinks: ${path}`,
        );
      }
      if (
        metadata.isDirectory() &&
        directory === root &&
        ignoredRootDirectories.has(entry.name)
      ) {
        continue;
      }
      if (metadata.isDirectory()) await visit(path);
      else if (metadata.isFile()) result.push(path);
    }
  };
  await visit(root);
  return result.sort();
};

const assertDirectoryRoot = async (path: string): Promise<string> => {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Godot source root must be a real directory: ${path}`);
  }
  return realpath(path);
};

const hashTree = async (root: string): Promise<string> => {
  await assertDirectoryRoot(root);
  const hash = createHash("sha256");
  for (const path of await collectFiles(root)) {
    hash.update(relative(root, path).split(sep).join("/"));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
};

export const fingerprintGodotSourceTrees = async (options: {
  readonly fixtureSource: string;
  readonly addonSource: string;
}): Promise<{
  readonly fixtureHash: string;
  readonly addonHash: string;
  readonly projectHash: string;
}> => {
  const [fixtureHash, addonHash] = await Promise.all([
    hashTree(resolve(options.fixtureSource)),
    hashTree(resolve(options.addonSource)),
  ]);
  return {
    fixtureHash,
    addonHash,
    projectHash: createHash("sha256")
      .update(`${fixtureHash}\0${addonHash}`)
      .digest("hex"),
  };
};

const hashSelectedFiles = async (
  root: string,
  files: readonly string[],
): Promise<string> => {
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(relative(root, path).split(sep).join("/"));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
};

/**
 * Re-hashes the exact staged Fixture and Addon source trees. Godot's generated
 * top-level `.godot/` cache is excluded, but no other extra source path is.
 */
export const verifyStagedGodotProject = async (
  projectDirectoryInput: string,
  expected: { readonly projectHash: string; readonly addonHash: string },
): Promise<void> => {
  const projectDirectory = resolve(projectDirectoryInput);
  const addonDirectory = resolve(projectDirectory, "addons", "chronorift");
  const [canonicalProject, canonicalAddon] = await Promise.all([
    assertDirectoryRoot(projectDirectory),
    assertDirectoryRoot(addonDirectory),
  ]);
  assertContained(canonicalProject, canonicalAddon);
  const [projectFiles, addonFiles] = await Promise.all([
    collectFiles(projectDirectory, new Set([".godot"])),
    collectFiles(addonDirectory),
  ]);
  const addonPrefix = `${addonDirectory}${sep}`;
  const fixtureFiles = projectFiles.filter(
    (path) => path !== addonDirectory && !path.startsWith(addonPrefix),
  );
  const [fixtureHash, addonHash] = await Promise.all([
    hashSelectedFiles(projectDirectory, fixtureFiles),
    hashSelectedFiles(addonDirectory, addonFiles),
  ]);
  const projectHash = createHash("sha256")
    .update(`${fixtureHash}\0${addonHash}`)
    .digest("hex");
  if (
    addonHash !== expected.addonHash ||
    projectHash !== expected.projectHash
  ) {
    throw new Error(
      `Staged Godot project integrity mismatch: expected ${expected.projectHash}/${expected.addonHash}, received ${projectHash}/${addonHash}`,
    );
  }
};

/**
 * Removes only Godot's generated project-local cache after the staged source
 * tree has been verified. Formal launches must not consume an unattested
 * cache left by an earlier process.
 */
export const clearGeneratedGodotCache = async (
  projectDirectoryInput: string,
): Promise<void> => {
  const projectDirectory = resolve(projectDirectoryInput);
  const canonicalProject = await assertDirectoryRoot(projectDirectory);
  const cacheDirectory = resolve(canonicalProject, ".godot");
  assertContained(canonicalProject, cacheDirectory);
  if (!(await pathExists(cacheDirectory))) return;
  const metadata = await lstat(cacheDirectory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(
      `Godot generated cache must be a real directory: ${cacheDirectory}`,
    );
  }
  await rm(cacheDirectory, { recursive: true, force: false });
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
};

export const stageGodotProject = async (options: {
  readonly artifactRoot: string;
  readonly directoryName: string;
  readonly fixtureSource: string;
  readonly addonSource: string;
  readonly projectHash: string;
  readonly addonHash: string;
}): Promise<string> => {
  const artifactRoot = resolve(options.artifactRoot);
  const projectsRoot = resolve(artifactRoot, "godot-projects");
  const projectDirectory = resolve(projectsRoot, options.directoryName);
  await mkdir(artifactRoot, { recursive: true });
  const canonicalArtifactRoot = await assertDirectoryRoot(artifactRoot);
  await mkdir(projectsRoot, { recursive: true });
  const canonicalProjectsRoot = await assertDirectoryRoot(projectsRoot);
  assertContained(canonicalArtifactRoot, canonicalProjectsRoot);
  assertContained(projectsRoot, projectDirectory);
  if (await pathExists(projectDirectory)) {
    const canonicalProject = await realpath(projectDirectory);
    assertContained(canonicalProjectsRoot, canonicalProject);
    await verifyStagedGodotProject(projectDirectory, options);
    return projectDirectory;
  }

  const temporary = await mkdtemp(join(projectsRoot, ".stage-"));
  const stagedProject = join(temporary, "project");
  try {
    await cp(options.fixtureSource, stagedProject, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    const addonTarget = join(stagedProject, "addons", "chronorift");
    await mkdir(join(stagedProject, "addons"), { recursive: true });
    await cp(options.addonSource, addonTarget, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    await verifyStagedGodotProject(stagedProject, options);
    try {
      await rename(stagedProject, projectDirectory);
    } catch (error) {
      if (!(await pathExists(projectDirectory))) throw error;
      await verifyStagedGodotProject(projectDirectory, options);
    }
  } finally {
    if (await pathExists(temporary)) {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  await verifyStagedGodotProject(projectDirectory, options);
  return projectDirectory;
};

const initialParticipantState = Object.freeze({
  switchActive: false,
  doorOpen: false,
  receiverConnected: false,
  initializationPending: true,
});

export const createInitialGodotSnapshot = (): EnvironmentSnapshot =>
  EnvironmentSnapshotSchema.parse({
    state: {
      values: {
        "switch.active": false,
        "door.open": false,
        "door.receiver_connected": false,
      },
    },
    runtimeState: {
      nowUs: 0,
      nextTick: 0,
      participants: { "switch-door": initialParticipantState },
    },
    rngState: {},
    pendingEffects: { deferredCallsDrained: false },
  });

const platformName = (): string => {
  if (process.platform === "linux") return "Linux";
  if (process.platform === "darwin") return "macOS";
  if (process.platform === "win32") return "Windows";
  return process.platform;
};

export interface PreparedGodotFixture {
  readonly projectDirectory: string;
  readonly addonHash: string;
  readonly projectHash: string;
  readonly doctor: GodotDoctorReport;
  readonly environment: EnvironmentRef;
  readonly initialCheckpointContent: CheckpointContent;
  readonly checkpointId: ReturnType<typeof asCheckpointId>;
}

export interface PrepareGodotFixtureOptions {
  readonly cwd: string;
  readonly artifactRoot: string;
  readonly godotBin?: string | undefined;
  readonly checkpointLevel?: "l0_restart" | "fixture_semantic_l2" | undefined;
}

export const prepareGodotSwitchDoorFixture = async (
  options: PrepareGodotFixtureOptions,
): Promise<PreparedGodotFixture> => {
  const cwd = resolve(options.cwd);
  const artifactRoot = resolve(options.artifactRoot);
  const addonSource = resolve(cwd, "godot/addons/chronorift");
  const fixtureSource = resolve(cwd, "fixtures/godot-switch-door");
  for (const source of [addonSource, fixtureSource]) {
    const metadata = await stat(source);
    if (!metadata.isDirectory())
      throw new Error(`Missing source directory: ${source}`);
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
    directoryName: `switch-door-${projectHash.slice(0, 16)}`,
    fixtureSource,
    addonSource,
    projectHash,
    addonHash,
  });

  const fingerprint: RuntimeFingerprintV1 = RuntimeFingerprintV1Schema.parse({
    schemaVersion: 1,
    engine: "godot",
    engineVersion: "4.7.1-stable (official)",
    adapterVersion: GODOT_ADAPTER_VERSION,
    protocolVersion: 2,
    platform: platformName(),
    renderer: "gl_compatibility",
    physicsTicksPerSecond: 60,
    fixedFps: GODOT_FIXED_FPS,
    projectHash,
    addonHash,
    capabilities: GODOT_CAPABILITIES,
  });
  const environment = EnvironmentRefSchema.parse({
    adapter: GODOT_ADAPTER,
    adapterVersion: GODOT_ADAPTER_VERSION,
    scene: GODOT_FIXTURE_SCENE,
    build: `godot:${doctor.version}:${projectHash}`,
    runtimeFingerprint: fingerprint,
  });
  const snapshot = createInitialGodotSnapshot();
  const participantHash = payloadHash(initialParticipantState);
  const level = options.checkpointLevel ?? "fixture_semantic_l2";
  const certificate: CheckpointCertificateV1 =
    CheckpointCertificateV1Schema.parse({
      schemaVersion: 1,
      level,
      captureConsistencyModel:
        level === "l0_restart" ? "fresh_scene" : "frame_end_barrier",
      adapterSemanticBarrier:
        level === "l0_restart"
          ? "godot.fresh_scene_before_logical_step"
          : "chronorift.frame_end_deferred",
      environmentFingerprint: fingerprint,
      coveredStateDomains: requiredCoverage,
      missingStateDomains: missingDomains,
      externalDependencies: [],
      rngDomains: [],
      pendingAsyncOperations: ["untracked_deferred_calls"],
      restoreRecipeHash: payloadHash(snapshot as unknown as JsonValue),
      restoreValidation: [
        {
          participantId: "switch-door",
          status: "pass",
          stateHash: participantHash,
          message: "Initial fixture participant state is canonical",
        },
      ],
      portability: "same_build_only",
      limitations: [
        level === "l0_restart"
          ? "Restore uses a fresh Godot process and scene recipe"
          : "Only the registered switch-door participant is restored",
        "Godot engine internals are not checkpointed",
      ],
    });
  const initialCheckpointContent: CheckpointContent = {
    schemaVersion: 1,
    environment,
    nextTick: 0,
    simTimeUs: 0,
    snapshot,
    certificate,
  };
  const checkpointId = asCheckpointId(
    `checkpoint:godot:${payloadHash(initialCheckpointContent as unknown as JsonValue)}`,
  );
  return {
    projectDirectory,
    addonHash,
    projectHash,
    doctor,
    environment,
    initialCheckpointContent,
    checkpointId,
  };
};

export const preparedFixtureName = (fixture: PreparedGodotFixture): string =>
  basename(fixture.projectDirectory);
