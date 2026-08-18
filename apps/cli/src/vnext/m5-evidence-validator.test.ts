import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error The intentionally independent Node validator has no TS API.
import * as independentValidatorModule from "../../../../.github/scripts/validate-vnext-m5-evidence.mjs";

type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
interface ValidationProfile {
  readonly taskSpecRawSha256: string;
  readonly schemaRawSha256: string;
  readonly schemaPath: string;
}
const { M5_DEFAULT_VALIDATION_PROFILE_V1, validateVNextM5Evidence } =
  independentValidatorModule as unknown as {
    readonly M5_DEFAULT_VALIDATION_PROFILE_V1: Readonly<ValidationProfile>;
    readonly validateVNextM5Evidence: (
      argv: readonly string[],
      validationProfile: ValidationProfile,
    ) => Promise<string>;
  };

const roots: string[] = [];
const officialSpecPath = resolve(
  "testdata/vnext/m5/moddable-platformer.behavior-change-task.v1.json",
);
const officialSchemaPath = resolve(
  "testdata/vnext/m5/evidence-bundle.schema.v1.json",
);
const changedPath = "components/spawner/spawner_broken.gd";
const activeTools = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "game_capabilities",
  "game_launch",
  "game_status",
  "game_stop",
  "game_query",
  "game_checkpoint_create",
  "game_checkpoint_restore",
  "game_fork",
  "game_trace_create",
  "game_trace_replay",
  "game_compare",
] as const;
const inventory = [
  "candidate.patch",
  "cleanup-receipt.json",
  "patch-export-receipt.json",
  "runtime-records/baseline/build.json",
  "runtime-records/baseline/events.jsonl",
  "runtime-records/baseline/execution-seal.json",
  "runtime-records/baseline/execution.json",
  "runtime-records/baseline/runtime.json",
  "runtime-records/candidate/build.json",
  "runtime-records/candidate/events.jsonl",
  "runtime-records/candidate/execution-seal.json",
  "runtime-records/candidate/execution.json",
  "runtime-records/candidate/runtime.json",
  "summary.json",
] as const;
const defaultValidationProfile = M5_DEFAULT_VALIDATION_PROFILE_V1;

const requiredValue = (
  value: JsonValue | undefined,
  label: string,
): JsonValue => {
  if (value === undefined) throw new Error(`fixture is missing ${label}`);
  return value;
};
const object = (
  value: JsonValue | undefined,
  label = "required object",
): JsonObject => {
  const resolved = requiredValue(value, label);
  if (
    resolved === null ||
    Array.isArray(resolved) ||
    typeof resolved !== "object"
  ) {
    throw new Error(`fixture ${label} is not an object`);
  }
  return resolved;
};
const field = (value: JsonObject, key: string): JsonValue =>
  requiredValue(value[key], key);
const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const canonicalJson = (value: JsonValue): string => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
};

const contentHash = (value: JsonValue): string => sha256(canonicalJson(value));
const withOwnHash = (
  value: JsonObject,
  field:
    "manifestContentSha256" | "summaryContentSha256" | "receiptContentSha256",
): JsonObject => ({ ...value, [field]: contentHash(value) });
const canonicalBytes = (value: JsonValue): Buffer =>
  Buffer.from(`${canonicalJson(value)}\n`, "utf8");

const writeCanonical = async (
  path: string,
  value: JsonValue,
): Promise<Buffer> => {
  await mkdir(dirname(path), { recursive: true });
  const bytes = canonicalBytes(value);
  await writeFile(path, bytes, { flag: "wx" });
  return bytes;
};

const selectedTreeHash = (
  entries: readonly {
    readonly path: string;
    readonly mode: "100644" | "100755";
    readonly bytes: Buffer;
  }[],
): string => {
  const hash = createHash("sha256").update("chronorift-selected-tree-v1\0");
  for (const entry of [...entries].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
  )) {
    const path = Buffer.from(entry.path, "utf8");
    hash.update(`${path.byteLength}:`);
    hash.update(path);
    hash.update(`\0${entry.mode}\0${entry.bytes.byteLength}:`);
    hash.update(entry.bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
};

const git = (cwd: string, args: readonly string[]): Buffer =>
  Buffer.from(
    execFileSync("/usr/bin/git", [...args], {
      cwd,
      encoding: null,
      env: {
        PATH: "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
        HOME: cwd,
        XDG_CONFIG_HOME: cwd,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_ATTR_NOSYSTEM: "1",
      },
    }),
  );

const resourceDigest = (
  taskId: string,
  kind: "build" | "runtime" | "execution",
  resourceId: string,
): string =>
  sha256(
    `chronorift-vnext-runtime-resource-v1\0${taskId}\0${kind}\0${resourceId}`,
  );

const envelope = (
  taskId: string,
  kind: "build" | "runtime" | "execution",
  resourceId: string,
  payload: JsonObject,
): JsonObject => {
  const basis: JsonObject = {
    schemaVersion: 1,
    taskId,
    resourceKind: kind,
    resourceId,
    resourceDigest: resourceDigest(taskId, kind, resourceId),
    payload,
    payloadHash: contentHash(payload),
  };
  return { ...basis, recordHash: contentHash(basis) };
};

const coverage = (count: number): JsonValue[] =>
  ["clock", "state", "entity_lifecycle", "log", "error"].map(
    (channel, index) => ({
      channel,
      status: index < 3 ? "partial" : "unavailable",
      emittedRecords: index < 3 ? count : 0,
      droppedRecords: 0,
      limitations: ["Endpoint observation is intentionally incomplete."],
    }),
  );

const loss: JsonValue[] = [
  {
    channel: "clock/state/entity_lifecycle",
    kind: "observer_effect",
    count: 0,
    reason: "Endpoint serialization can affect observation timing.",
  },
  {
    channel: "log/error",
    kind: "unavailable",
    count: 0,
    reason: "This semantic record does not index process diagnostics.",
  },
];

const projection = (input: {
  readonly simulationTimeUs: number;
  readonly waitTimeSeconds: number;
  readonly spawned: boolean;
}): JsonObject => ({
  schemaVersion: 1,
  stateSchemaVersion: "chronorift.timer-spawn:v1",
  subject: {
    stableId: "semantic:subject",
    incarnation: 1,
    targetScene: "res://components/spawner/enemy_spawner_broken.tscn",
    spawnIntervalSeconds: 1,
    spawnScene: "res://actors/enemy.tscn",
  },
  timer: {
    stableId: "semantic:timer",
    incarnation: 1,
    waitTimeSeconds: input.waitTimeSeconds,
    timeLeftSeconds: input.spawned ? input.waitTimeSeconds : 0.5,
    paused: false,
    stopped: false,
    oneShot: false,
    autostart: false,
    processCallback: "idle",
    ignoreTimeScale: false,
    timeoutOrdinal: input.spawned ? 1 : 0,
  },
  entities: input.spawned
    ? [
        {
          stableId: "semantic:spawn:0",
          incarnation: 1,
          spawnOrdinal: 0,
          scene: "res://actors/enemy.tscn",
          parentStableId: "semantic:harness",
          transform: {
            position: { x: 0, y: 0 },
            rotation: 0,
            scale: { x: 1, y: 1 },
          },
          visible: true,
          processMode: 0,
          velocity: { x: 0, y: 0 },
        },
      ]
    : [],
  nextSpawnOrdinal: input.spawned ? 1 : 0,
  capturedAt: {
    processFrame: Math.max(1, Math.floor(input.simulationTimeUs / 16_000)),
    physicsTick: Math.max(1, Math.floor(input.simulationTimeUs / 16_666)),
    simulationTimeUs: input.simulationTimeUs,
    hostMonotonicUs: null,
    renderFrame: null,
  },
});

interface RuntimeFixture {
  readonly references: JsonObject;
  readonly executionId: string;
  readonly buildId: string;
  readonly runtimeId: string;
}

const buildRuntime = async (input: {
  readonly root: string;
  readonly role: "baseline" | "candidate";
  readonly taskId: string;
  readonly baselineSourceHash: string;
  readonly sourceHash: string;
  readonly baselineSpawnAtShutdown: boolean;
  readonly candidateLaterSpawn: boolean;
  readonly tamperSeal: boolean;
  readonly hostMonotonicBaseUs: number;
}): Promise<RuntimeFixture> => {
  const { role, taskId } = input;
  const workspaceId = "workspace:m5-validator";
  const sourceId = `source:${input.sourceHash}`;
  const buildConfigurationHash = sha256("build-configuration");
  const outputHash = sha256(`output-${role}`);
  const buildId = `build:${contentHash({
    schemaVersion: 1,
    projectHash: outputHash,
    buildConfigurationHash,
    outputHash,
  })}`;
  const runtimeId = `runtime:m5-validator:${role}`;
  const executionId = `execution:m5-validator:${role}`;
  const adapterId = "adapter:m5-validator";
  const build: JsonObject = {
    schemaVersion: 1,
    taskId,
    workspaceId,
    sourceId,
    buildId,
    sourceHash: input.sourceHash,
    workspaceDiffHash: contentHash({
      schemaVersion: 1,
      baselineSourceHash: input.baselineSourceHash,
      candidateSourceHash: input.sourceHash,
    }),
    buildConfigurationHash,
    outputHash,
    createdAt: "2026-08-12T00:00:00.000Z",
  };
  const samples =
    role === "baseline"
      ? [
          {
            source: "ready",
            simulationTimeUs: 1_000,
            spawned: !input.baselineSpawnAtShutdown,
          },
          {
            source: "shutdown",
            simulationTimeUs: input.baselineSpawnAtShutdown ? 1_000_000 : 2_000,
            spawned: true,
          },
        ]
      : [
          { source: "ready", simulationTimeUs: 1_000, spawned: false },
          { source: "status", simulationTimeUs: 100_000, spawned: false },
          {
            source: "shutdown",
            // Deliberately exceeds the retired 120 s endpoint deadline. This
            // samples eventual behavior without turning Agent response time
            // into a game-behavior bound.
            simulationTimeUs: 182_000_000,
            spawned: input.candidateLaterSpawn,
          },
        ];
  const eventValues: JsonObject[] = [];
  let previousHash: string | null = null;
  for (const [sequence, sample] of samples.entries()) {
    const observed = projection({
      simulationTimeUs: sample.simulationTimeUs,
      waitTimeSeconds: role === "baseline" ? 0.001 : 1,
      spawned: sample.spawned,
    });
    const payload: JsonObject = {
      schemaVersion: 1,
      eventKind: "semantic_observation",
      taskId,
      executionId,
      runtimeId,
      buildId,
      sequence,
      source: sample.source,
      hostMonotonicStartUs: input.hostMonotonicBaseUs + sequence * 100_000,
      hostMonotonicEndUs: input.hostMonotonicBaseUs + sequence * 100_000 + 100,
      projectionSha256: contentHash(observed),
      projection: observed,
    };
    const basis: JsonObject = {
      schemaVersion: 1,
      taskId,
      executionId,
      sequence,
      previousHash,
      payload,
      payloadHash: contentHash(payload),
    };
    const event = { ...basis, recordHash: contentHash(basis) };
    eventValues.push(event);
    previousHash = String(event.recordHash);
  }
  const eventBytes = Buffer.from(
    eventValues.map((event) => `${canonicalJson(event)}\n`).join(""),
    "utf8",
  );
  const seal: JsonObject = {
    schemaVersion: 1,
    taskId,
    executionId,
    count: eventValues.length,
    headHash: input.tamperSeal ? "f".repeat(64) : previousHash,
    byteLength: eventBytes.byteLength,
    contentHash: sha256(eventBytes),
  };
  const finalProjection = field(
    object(field(object(eventValues.at(-1), "last event"), "payload")),
    "projection",
  );
  const runtime: JsonObject = {
    schemaVersion: 1,
    runtimeKind: "godot_external_semantic",
    taskId,
    runtimeId,
    executionId,
    buildId,
    adapterId,
    adapterProfileSha256:
      "2600ae0d42a463d78a7c74b987799e74e7391c254f806ddbcc86b2256591f0e4",
    status: "stopped",
    finalProjectionSha256: contentHash(finalProjection),
    finalProjection,
    coverage: coverage(eventValues.length),
    loss,
    cleanupProven: true,
  };
  const execution: JsonObject = {
    schemaVersion: 1,
    executionKind: "godot_external_semantic",
    taskId,
    executionId,
    runtimeId,
    workspaceId,
    sourceId,
    buildId,
    adapterId,
    adapterProfileSha256:
      "2600ae0d42a463d78a7c74b987799e74e7391c254f806ddbcc86b2256591f0e4",
    targetScene: "res://components/spawner/enemy_spawner_broken.tscn",
    stateSchemaVersion: "chronorift.timer-spawn:v1",
    fidelity: "descriptive_only",
    equivalentForkEligible: false,
    eventCount: eventValues.length,
    coverage: coverage(eventValues.length),
    loss,
    executionSeal: seal,
  };
  const directory = join(input.root, "runtime-records", role);
  await mkdir(directory, { recursive: true });
  const artifacts = {
    build: await writeCanonical(
      join(directory, "build.json"),
      envelope(taskId, "build", buildId, build),
    ),
    runtime: await writeCanonical(
      join(directory, "runtime.json"),
      envelope(taskId, "runtime", runtimeId, runtime),
    ),
    execution: await writeCanonical(
      join(directory, "execution.json"),
      envelope(taskId, "execution", executionId, execution),
    ),
    events: eventBytes,
    executionSeal: await writeCanonical(
      join(directory, "execution-seal.json"),
      seal,
    ),
  };
  await writeFile(join(directory, "events.jsonl"), eventBytes, { flag: "wx" });
  const reference = (
    name: keyof typeof artifacts,
    file: string,
  ): JsonObject => ({
    relativePath: `runtime-records/${role}/${file}`,
    rawSha256: sha256(artifacts[name]),
  });
  return {
    executionId,
    buildId,
    runtimeId,
    references: {
      expectedSourceHash: input.sourceHash,
      build: reference("build", "build.json"),
      runtime: reference("runtime", "runtime.json"),
      execution: reference("execution", "execution.json"),
      events: reference("events", "events.jsonl"),
      executionSeal: reference("executionSeal", "execution-seal.json"),
    },
  };
};

interface Fixture {
  readonly root: string;
  readonly baselineRoot: string;
  readonly bundleRoot: string;
  readonly taskSpecPath: string;
  readonly schemaPath: string;
  readonly validationProfile: ValidationProfile;
}

const buildFixture = async (
  options: {
    readonly candidateLaterSpawn?: boolean;
    readonly tamperSeal?: boolean;
    readonly reversedExecutionOrder?: boolean;
    readonly baselineReproductionAfterCandidateReady?: boolean;
  } = {},
): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-m5-validator-"));
  roots.push(root);
  const baselineRoot = join(root, "baseline");
  const patchWorkspace = join(root, "patch-workspace");
  const bundleRoot = join(root, "bundle");
  await Promise.all([
    mkdir(join(baselineRoot, dirname(changedPath)), { recursive: true }),
    mkdir(join(patchWorkspace, dirname(changedPath)), { recursive: true }),
    mkdir(bundleRoot),
  ]);
  const baselineBytes = Buffer.from(
    "extends Node\nfunc start(timer: Timer, spawn_interval: float) -> void:\n\ttimer.start(spawn_interval / 1000)\n",
    "utf8",
  );
  const candidateBytes = Buffer.from(
    "extends Node\nfunc start(timer: Timer, spawn_interval: float) -> void:\n\ttimer.start(spawn_interval)\n",
    "utf8",
  );
  await Promise.all([
    writeFile(join(baselineRoot, changedPath), baselineBytes),
    writeFile(join(patchWorkspace, changedPath), baselineBytes),
  ]);
  git(baselineRoot, ["init", "--quiet", "--object-format=sha1"]);
  git(baselineRoot, ["config", "core.autocrlf", "false"]);
  git(baselineRoot, ["config", "core.filemode", "true"]);
  git(baselineRoot, ["config", "user.name", "M5 fixture"]);
  git(baselineRoot, ["config", "user.email", "fixture@chronorift.invalid"]);
  git(baselineRoot, ["add", "--all"]);
  git(baselineRoot, ["commit", "--quiet", "-m", "frozen baseline"]);
  const baselineHeadCommit = git(baselineRoot, [
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ])
    .toString("utf8")
    .trimEnd();
  const baselineGitTree = git(baselineRoot, [
    "rev-parse",
    "--verify",
    "HEAD^{tree}",
  ])
    .toString("utf8")
    .trimEnd();
  const baselineSourceHash = selectedTreeHash([
    { path: changedPath, mode: "100644", bytes: baselineBytes },
  ]);
  const candidateSourceHash = selectedTreeHash([
    { path: changedPath, mode: "100644", bytes: candidateBytes },
  ]);

  git(patchWorkspace, ["init", "--quiet", "--object-format=sha1"]);
  git(patchWorkspace, ["config", "core.autocrlf", "false"]);
  git(patchWorkspace, ["config", "core.filemode", "true"]);
  git(patchWorkspace, ["config", "user.name", "M5 fixture"]);
  git(patchWorkspace, ["config", "user.email", "fixture@chronorift.invalid"]);
  git(patchWorkspace, ["add", "--all"]);
  git(patchWorkspace, ["commit", "--quiet", "-m", "baseline"]);
  await writeFile(join(patchWorkspace, changedPath), candidateBytes);
  git(patchWorkspace, ["add", "--all"]);
  const patchBytes = git(patchWorkspace, [
    "diff",
    "--cached",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "HEAD",
    "--",
  ]);
  await writeFile(join(bundleRoot, "candidate.patch"), patchBytes, {
    flag: "wx",
  });

  const taskSpec = JSON.parse(
    await readFile(officialSpecPath, "utf8"),
  ) as JsonObject;
  const fixtureSource = object(taskSpec.source);
  fixtureSource.headCommit = baselineHeadCommit;
  fixtureSource.gitTreeObjectId = baselineGitTree;
  fixtureSource.selectedTreeSha256 = baselineSourceHash;
  const taskSpecPath = join(root, "task-spec.json");
  const taskSpecBytes = Buffer.from(`${JSON.stringify(taskSpec, null, 2)}\n`);
  await writeFile(taskSpecPath, taskSpecBytes, { flag: "wx" });

  const schema = JSON.parse(
    await readFile(officialSchemaPath, "utf8"),
  ) as JsonObject;
  const schemaProperties = object(schema.properties);
  const sourceSchema = object(schemaProperties.source);
  const sourceProperties = object(sourceSchema.properties);
  object(sourceProperties.headCommit).const = baselineHeadCommit;
  object(sourceProperties.gitTreeObjectId).const = baselineGitTree;
  object(sourceProperties.baselineSelectedTreeSha256).const =
    baselineSourceHash;
  const schemaPath = join(root, "evidence-schema.json");
  const schemaBytes = Buffer.from(`${JSON.stringify(schema, null, 2)}\n`);
  await writeFile(schemaPath, schemaBytes, { flag: "wx" });

  const taskId = "task:m5-validator-fixture";
  const taskSpecSha256 = sha256(taskSpecBytes);
  const patchHash = sha256(patchBytes);
  const patchId = `patch:v1:${patchHash}`;
  const exportReceipt: JsonObject = {
    schemaVersion: 1,
    taskId,
    patchId,
    patchSha256: patchHash,
    outputPath: "candidate.patch",
    byteLength: patchBytes.byteLength,
    exportedAt: "2026-08-12T00:00:00.000Z",
    status: "completed",
  };
  const exportBytes = await writeCanonical(
    join(bundleRoot, "patch-export-receipt.json"),
    exportReceipt,
  );
  const [baseline, candidate] = await Promise.all([
    buildRuntime({
      root: bundleRoot,
      role: "baseline",
      taskId,
      baselineSourceHash,
      sourceHash: baselineSourceHash,
      // The semantic wire samples at command endpoints. Keep the first
      // spawn-present baseline projection well beyond 250 ms so the accepted
      // fixture cannot accidentally reintroduce a model-latency bound.
      baselineSpawnAtShutdown: true,
      candidateLaterSpawn: true,
      tamperSeal: false,
      hostMonotonicBaseUs: options.reversedExecutionOrder
        ? 2_000_000
        : 1_000_000,
    }),
    buildRuntime({
      root: bundleRoot,
      role: "candidate",
      taskId,
      baselineSourceHash,
      sourceHash: candidateSourceHash,
      baselineSpawnAtShutdown: false,
      candidateLaterSpawn: options.candidateLaterSpawn ?? true,
      tamperSeal: options.tamperSeal ?? false,
      hostMonotonicBaseUs: options.reversedExecutionOrder
        ? 1_000_000
        : options.baselineReproductionAfterCandidateReady
          ? 1_050_000
          : 2_000_000,
    }),
  ]);
  const cleanupBasis: JsonObject = {
    schemaVersion: 1,
    receiptKind: "chronorift-m5-task-discard-cleanup",
    taskSpecSha256,
    taskId,
    taskNamespaceDigest: sha256(`chronorift-task-namespace-v1\0${taskId}`),
    patchId,
    baselineSourceHash,
    candidateSourceHash,
    baselineExecutionId: baseline.executionId,
    candidateExecutionId: candidate.executionId,
    processGroupTerminated: true,
    cgroupPopulated: false,
    termSent: true,
    killSent: false,
    scopeRemoved: true,
    storageReconciled: true,
    taskRootRemoved: true,
    boundedTaskStorageEmpty: true,
    taskCgroupLeavesEmpty: true,
    sourceUnchanged: true,
  };
  const cleanup = withOwnHash(cleanupBasis, "receiptContentSha256");
  const cleanupBytes = await writeCanonical(
    join(bundleRoot, "cleanup-receipt.json"),
    cleanup,
  );
  const productSubject: JsonObject = {
    repositoryCommit: "a".repeat(40),
    repositoryTree: "b".repeat(40),
    clean: true,
  };
  const taskSource = object(taskSpec.source, "task source");
  const taskSemanticProfile = object(
    taskSpec.semanticProfile,
    "task semantic profile",
  );
  const summaryBasis: JsonObject = {
    schemaVersion: 1,
    evidenceKind: "chronorift-m5-public-exposed-behavior-change-conformance",
    taskClassification: "public_exposed_behavior_change_conformance",
    taskSpecSha256,
    taskId,
    claimsExcluded: field(taskSpec, "claimsExcluded"),
    agent: {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      thinkingLevel: "max",
      attemptOrdinal: 1,
      turnCount: 1,
      loopStatus: "completed",
      requestedTaskSandboxNetworkMode: "denied",
      hostModelNetworkPolicy: "provider_only",
      taskCredentialMountCountMaximum: 0,
      totalToolCallCount: 8,
      activeTools: [...activeTools],
    },
    productSubject,
    toolchain: field(taskSpec, "toolchain"),
    source: {
      declaredUrl: field(taskSource, "declaredUrl"),
      headCommit: field(taskSource, "headCommit"),
      gitTreeObjectId: field(taskSource, "gitTreeObjectId"),
      baselineSelectedTreeSha256: baselineSourceHash,
      hostUnchangedAfterTask: true,
    },
    semanticProfile: {
      taskProfile: field(taskSemanticProfile, "taskProfile"),
      protocolProfile: field(taskSemanticProfile, "protocolProfile"),
      adapterProfileSha256: field(
        taskSemanticProfile,
        "adapterProfileCanonicalSha256",
      ),
      targetScene: field(taskSemanticProfile, "targetScene"),
    },
    patch: {
      identity: {
        schemaVersion: 1,
        patchId,
        taskId,
        baselineSourceHash,
        candidateSourceHash,
        patchHash,
        byteLength: patchBytes.byteLength,
      },
      artifact: {
        relativePath: "candidate.patch",
        rawSha256: patchHash,
      },
      exportReceipt: {
        relativePath: "patch-export-receipt.json",
        rawSha256: sha256(exportBytes),
      },
      changedPaths: [changedPath],
      roundTripSelectedTreeSha256: candidateSourceHash,
      roundTripVerified: true,
    },
    executions: {
      baseline: baseline.references,
      candidate: candidate.references,
    },
    cleanup: {
      relativePath: "cleanup-receipt.json",
      rawSha256: sha256(cleanupBytes),
    },
  };
  const summary = withOwnHash(summaryBasis, "summaryContentSha256");
  await writeCanonical(join(bundleRoot, "summary.json"), summary);

  const references = await Promise.all(
    inventory.map(async (relativePath) => ({
      relativePath,
      rawSha256: sha256(await readFile(join(bundleRoot, relativePath))),
    })),
  );
  const manifest = withOwnHash(
    {
      schemaVersion: 1,
      bundleKind: "chronorift-m5-evidence-bundle",
      taskSpecSha256,
      taskId,
      productSubject,
      artifacts: references,
    },
    "manifestContentSha256",
  );
  await writeCanonical(join(bundleRoot, "manifest.json"), manifest);
  return {
    root,
    baselineRoot,
    bundleRoot,
    taskSpecPath,
    schemaPath,
    validationProfile: {
      taskSpecRawSha256: taskSpecSha256,
      schemaRawSha256: sha256(schemaBytes),
      schemaPath,
    },
  };
};

const validate = (fixture: Fixture): Promise<string> =>
  validateVNextM5Evidence(
    [
      fixture.taskSpecPath,
      fixture.schemaPath,
      fixture.bundleRoot,
      fixture.baselineRoot,
    ],
    fixture.validationProfile,
  );

const rewriteManifestReference = async (
  fixture: Fixture,
  relativePath: string,
): Promise<void> => {
  const manifestPath = join(fixture.bundleRoot, "manifest.json");
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as JsonObject;
  const reference = (manifest.artifacts as JsonObject[]).find(
    (entry) => entry.relativePath === relativePath,
  );
  if (reference === undefined)
    throw new Error("fixture manifest reference missing");
  reference.rawSha256 = sha256(
    await readFile(join(fixture.bundleRoot, relativePath)),
  );
  delete manifest.manifestContentSha256;
  const updated = withOwnHash(manifest, "manifestContentSha256");
  await writeFile(manifestPath, canonicalBytes(updated));
};

const rewriteManifestReferences = async (
  fixture: Fixture,
  relativePaths: readonly string[],
): Promise<void> => {
  for (const relativePath of relativePaths) {
    await rewriteManifestReference(fixture, relativePath);
  }
};

const rewriteSummary = async (
  fixture: Fixture,
  mutate: (summary: JsonObject) => void,
): Promise<void> => {
  const summaryPath = join(fixture.bundleRoot, "summary.json");
  const summary = JSON.parse(await readFile(summaryPath, "utf8")) as JsonObject;
  delete summary.summaryContentSha256;
  mutate(summary);
  await writeFile(
    summaryPath,
    canonicalBytes(withOwnHash(summary, "summaryContentSha256")),
  );
  await rewriteManifestReference(fixture, "summary.json");
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("independent M5 evidence bundle validator", () => {
  it("pins the exact official task spec and evidence schema bytes", async () => {
    const [taskSpecBytes, schemaBytes] = await Promise.all([
      readFile(officialSpecPath),
      readFile(officialSchemaPath),
    ]);

    expect(sha256(taskSpecBytes)).toBe(
      defaultValidationProfile.taskSpecRawSha256,
    );
    expect(sha256(schemaBytes)).toBe(defaultValidationProfile.schemaRawSha256);
    expect(resolve(defaultValidationProfile.schemaPath)).toBe(
      officialSchemaPath,
    );
  });

  it("accepts a strict synthetic behavior-change bundle", async () => {
    const fixture = await buildFixture();

    await expect(validate(fixture)).resolves.toBe(
      "validated strict vNext M5 evidence bundle\n",
    );
  });

  it("rejects a dirty baseline even when its selected files still hash", async () => {
    const fixture = await buildFixture();
    await writeFile(join(fixture.baselineRoot, "ignored.tmp"), "untracked\n");

    await expect(validate(fixture)).rejects.toThrow(
      /baseline Git root is not clean including ignored files/u,
    );
  });

  it("rejects an internally hashed candidate without the later spawn", async () => {
    const fixture = await buildFixture({ candidateLaterSpawn: false });

    await expect(validate(fixture)).rejects.toThrow(
      /candidate execution has no later spawned-entity observation/u,
    );
  });

  it("rejects a candidate execution selected before the baseline", async () => {
    const fixture = await buildFixture({ reversedExecutionOrder: true });

    await expect(validate(fixture)).rejects.toThrow(
      /selected candidate does not begin after the selected baseline/u,
    );
  });

  it("rejects a candidate that starts before the decisive baseline reproduction observation", async () => {
    const fixture = await buildFixture({
      baselineReproductionAfterCandidateReady: true,
    });

    await expect(validate(fixture)).rejects.toThrow(
      /selected baseline behavior reproduction/u,
    );
  });

  it("rejects a logical/physical execution seal detached from its raw chain", async () => {
    const fixture = await buildFixture({ tamperSeal: true });

    await expect(validate(fixture)).rejects.toThrow(/seal head hash/u);
  });

  it("rejects unknown summary claims even when their hashes are recomputed", async () => {
    const fixture = await buildFixture();
    const summaryPath = join(fixture.bundleRoot, "summary.json");
    const summary = JSON.parse(
      await readFile(summaryPath, "utf8"),
    ) as JsonObject;
    delete summary.summaryContentSha256;
    summary.accepted = true;
    await writeFile(
      summaryPath,
      canonicalBytes(withOwnHash(summary, "summaryContentSha256")),
    );
    await rewriteManifestReference(fixture, "summary.json");

    await expect(validate(fixture)).rejects.toThrow(
      /\$summary\.accepted is not allowed/u,
    );
  });

  it("rejects extra files and symbolic links outside the exact closure", async () => {
    const extra = await buildFixture();
    await writeFile(
      join(extra.bundleRoot, "assistant-prose.txt"),
      "looks fixed\n",
    );
    await expect(validate(extra)).rejects.toThrow(/bundle file allowlist/u);

    const linked = await buildFixture();
    await symlink(
      "summary.json",
      join(linked.bundleRoot, "linked-summary.json"),
    );
    await expect(validate(linked)).rejects.toThrow(/symbolic link/u);
  });

  it("rejects cleanup facts that do not prove bounded storage cleanup", async () => {
    const fixture = await buildFixture();
    const cleanupPath = join(fixture.bundleRoot, "cleanup-receipt.json");
    const cleanup = JSON.parse(
      await readFile(cleanupPath, "utf8"),
    ) as JsonObject;
    delete cleanup.receiptContentSha256;
    cleanup.boundedTaskStorageEmpty = false;
    await writeFile(
      cleanupPath,
      canonicalBytes(withOwnHash(cleanup, "receiptContentSha256")),
    );
    await rewriteManifestReference(fixture, "cleanup-receipt.json");

    await expect(validate(fixture)).rejects.toThrow(
      /boundedTaskStorageEmpty does not equal its frozen value/u,
    );
  });

  it("rejects a forged full-index patch after every enclosing hash is rebound", async () => {
    const fixture = await buildFixture();
    const patchPath = join(fixture.bundleRoot, "candidate.patch");
    const original = await readFile(patchPath, "utf8");
    const forged = original.replace(
      /^(index )([a-f0-9]{40})(\.\.[a-f0-9]{40})/mu,
      (_match, prefix: string, left: string, suffix: string) =>
        `${prefix}${left.slice(1)}${suffix}`,
    );
    expect(forged).not.toBe(original);
    const bytes = Buffer.from(forged, "utf8");
    await writeFile(patchPath, bytes);
    const patchHash = sha256(bytes);
    const patchId = `patch:v1:${patchHash}`;

    const exportPath = join(fixture.bundleRoot, "patch-export-receipt.json");
    const receipt = JSON.parse(
      await readFile(exportPath, "utf8"),
    ) as JsonObject;
    receipt.patchId = patchId;
    receipt.patchSha256 = patchHash;
    receipt.byteLength = bytes.byteLength;
    await writeFile(exportPath, canonicalBytes(receipt));

    const cleanupPath = join(fixture.bundleRoot, "cleanup-receipt.json");
    const cleanup = JSON.parse(
      await readFile(cleanupPath, "utf8"),
    ) as JsonObject;
    delete cleanup.receiptContentSha256;
    cleanup.patchId = patchId;
    await writeFile(
      cleanupPath,
      canonicalBytes(withOwnHash(cleanup, "receiptContentSha256")),
    );
    await rewriteSummary(fixture, (summary) => {
      const patch = object(summary.patch);
      const identity = object(patch.identity);
      identity.patchId = patchId;
      identity.patchHash = patchHash;
      identity.byteLength = bytes.byteLength;
      object(patch.artifact).rawSha256 = patchHash;
      object(patch.exportReceipt).rawSha256 = sha256(canonicalBytes(receipt));
      object(summary.cleanup).rawSha256 = sha256(
        canonicalBytes(withOwnHash(cleanup, "receiptContentSha256")),
      );
    });
    await rewriteManifestReferences(fixture, [
      "candidate.patch",
      "patch-export-receipt.json",
      "cleanup-receipt.json",
    ]);

    await expect(validate(fixture)).rejects.toThrow(
      /does not use full-index object IDs/u,
    );
  });

  it("rejects cleanup lineage tampering after recomputing self and manifest hashes", async () => {
    const fixture = await buildFixture();
    const cleanupPath = join(fixture.bundleRoot, "cleanup-receipt.json");
    const cleanup = JSON.parse(
      await readFile(cleanupPath, "utf8"),
    ) as JsonObject;
    delete cleanup.receiptContentSha256;
    cleanup.candidateExecutionId = "execution:m5-validator:other";
    const updatedCleanup = withOwnHash(cleanup, "receiptContentSha256");
    await writeFile(cleanupPath, canonicalBytes(updatedCleanup));
    await rewriteSummary(fixture, (summary) => {
      object(summary.cleanup).rawSha256 = sha256(
        canonicalBytes(updatedCleanup),
      );
    });
    await rewriteManifestReference(fixture, "cleanup-receipt.json");

    await expect(validate(fixture)).rejects.toThrow(
      /cleanup candidate execution/u,
    );
  });

  it("rejects a runtime detached from its execution after rehashing the envelope", async () => {
    const fixture = await buildFixture();
    const relativePath = "runtime-records/candidate/runtime.json";
    const runtimePath = join(fixture.bundleRoot, relativePath);
    const record = JSON.parse(
      await readFile(runtimePath, "utf8"),
    ) as JsonObject;
    const payload = object(record.payload);
    payload.executionId = "execution:m5-validator:other";
    record.payloadHash = contentHash(payload);
    delete record.recordHash;
    record.recordHash = contentHash(record);
    const runtimeBytes = canonicalBytes(record);
    await writeFile(runtimePath, runtimeBytes);
    await rewriteSummary(fixture, (summary) => {
      const candidate = object(object(summary.executions).candidate);
      object(candidate.runtime).rawSha256 = sha256(runtimeBytes);
    });
    await rewriteManifestReference(fixture, relativePath);

    await expect(validate(fixture)).rejects.toThrow(
      /candidate runtime execution/u,
    );
  });
});
