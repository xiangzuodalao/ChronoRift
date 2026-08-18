import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  GAME_TOOL_NAMES_V1,
  LIFECYCLE_GAME_TOOL_NAMES_V1,
  LifecycleGameCapabilitiesOutputV2Schema,
  LifecycleGameLaunchOutputV2Schema,
  LifecycleGameStatusOutputV2Schema,
  LifecycleGameStopOutputV2Schema,
  type LifecycleGameCapabilitiesOutputV2,
  type LifecycleGameLaunchOutputV2,
  type LifecycleGameStatusOutputV2,
  type LifecycleGameStopOutputV2,
  type LifecycleGameToolNameV1,
} from "@chronorift/agent-protocol";
import {
  TaskPatchIdentityV1Schema,
  VNextLifecycleExecutionRecordV1Schema,
  asTaskId,
  lifecycleCleanupProven,
  type JsonValue,
  type VNextBoundedStreamReceiptV1,
  type VNextLifecycleExecutionRecordV1,
  type VNextLifecyclePhaseReceiptV1,
} from "@chronorift/domain";
import {
  DEFAULT_LIFECYCLE_SIDECAR_TARGETS,
  createLifecycleRuntimeSidecarSource,
  createLifecycleVanillaSmokeSidecarSource,
} from "@chronorift/godot-adapter";
import {
  VNextRuntimeStore,
  VNextTaskStore,
  contentHash,
} from "@chronorift/json-artifacts";
import {
  VNextGameToolResponseV1Schema,
  type RunVNextPiSdkTurnOptions,
  type VNextPiTurnResult,
} from "@chronorift/pi-harness";
import { type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  SandboxHostCapabilityV1Schema,
  SandboxOperationRecordV1Schema,
  SandboxPolicySchema,
  TaskGodotProjectCapabilityV1Schema,
} from "./contracts.js";
import { readGodotProjectDescriptorSnapshotV1 } from "./godot-project-descriptor.js";
import { ManagedGodotLifecycleRuntimeCapabilityV1Schema } from "./managed-godot-lifecycle-runtime.js";
import {
  continueVNextAgentTask,
  discardVNextAgentTask,
  exportVNextAgentTaskPatch,
  showVNextAgentTask,
  startVNextAgentTask,
} from "./task-agent.js";

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/u;
const FROZEN_DESCRIPTOR_SHA256 =
  "534dcd8aa14aeea74685059f8d66e44e5bebe21742b7a702ee7d78e91e1a955e";
const FROZEN_SPEC_SHA256 =
  "1fc43c0eaea45ed9fa129a7a2e06913c0cc37495633dc4d90dd3fd7598de5f82";
const FROZEN_CANDIDATE_SHA256 =
  "8aa71e3ea1839fb4a56940b25a3b61bc747bf712ec7a7221cdb42ecaaeeb2336";
const FROZEN_MARKER_CONTENT_SHA256 =
  "04b0627d60c82e79178aaf7d8b9c7a7591a6bef635be21226e6cae6235b4089e";
const CODING_TOOL_NAMES = Object.freeze([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const);
const EXPECTED_ACTIVE_TOOLS = Object.freeze([
  ...CODING_TOOL_NAMES,
  ...LIFECYCLE_GAME_TOOL_NAMES_V1,
]);
const NOT_EXPOSED_GAME_TOOLS = Object.freeze(
  Object.values(GAME_TOOL_NAMES_V1).filter(
    (name) =>
      !LIFECYCLE_GAME_TOOL_NAMES_V1.includes(name as LifecycleGameToolNameV1),
  ),
);
const EXPECTED_PHASES = Object.freeze([
  "vanilla_import",
  "vanilla_smoke",
  "managed_import",
  "managed_handshake",
  "managed_status",
  "managed_status",
  "managed_stop",
] as const);

const ConformanceSpecV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    profile: z.literal("chronorift-m4-external-project-conformance"),
    descriptorSha256: z.literal(FROZEN_DESCRIPTOR_SHA256),
    source: z
      .object({
        declaredUrl: z.literal(
          "https://github.com/endlessm/moddable-platformer",
        ),
        headCommit: z.literal("3e793f53598a131c53fb82555191cc14b8db07ff"),
        gitTreeObjectId: z.literal("a013bd677c712dbf354e8e2f6e8ff7c53d5684c6"),
        selectedTreeSha256: z.literal(
          "3e8bd6478d53586284010da38959005e2a377ef6277b2a838ecb1538abc096e8",
        ),
        entryCount: z.literal(543),
        declaredByteLength: z.literal(1_380_343),
      })
      .strict(),
    candidatePatch: z
      .object({
        relativePath: z.literal("CHRONORIFT_ONBOARDING_SMOKE.md"),
        mode: z.literal("100644"),
        contentUtf8: z.literal(
          "ChronoRift external-project onboarding conformance.\n",
        ),
        selectedTreeSha256: z.literal(
          "8aa71e3ea1839fb4a56940b25a3b61bc747bf712ec7a7221cdb42ecaaeeb2336",
        ),
      })
      .strict(),
    runtimeExpectations: z
      .object({
        vanillaStableMinimumMs: z.literal(2_000),
        minimumProcessFrames: z.literal(120),
        minimumPhysicsTicks: z.literal(120),
      })
      .strict(),
  })
  .strict();

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for M4 external-project conformance`);
  }
  return value;
};

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const diagnosticStream = (receipt: VNextBoundedStreamReceiptV1) => ({
  totalSha256: receipt.totalSha256,
  totalBytes: receipt.totalBytes,
  retainedBytes: receipt.retainedBytes,
  truncated: receipt.truncated,
});

const asError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

const git = async (root: string, args: readonly string[]): Promise<string> => {
  const result = await execFileAsync("/usr/bin/git", args, {
    cwd: root,
    env: {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    encoding: "utf8",
  });
  return result.stdout.trim();
};

const expectMissing = async (path: string): Promise<void> => {
  try {
    await lstat(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  throw new Error(`conformance output must not preexist: ${path}`);
};

const loadFrozenInputs = async () => {
  const sourceRoot = requiredEnvironment(
    "CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT",
  );
  const descriptorPath = requiredEnvironment(
    "CHRONORIFT_TEST_EXTERNAL_PROJECT_DESCRIPTOR",
  );
  const conformanceSpecPath = requiredEnvironment(
    "CHRONORIFT_TEST_EXTERNAL_PROJECT_CONFORMANCE_SPEC",
  );
  const evidenceSchemaPath = requiredEnvironment(
    "CHRONORIFT_TEST_EXTERNAL_PROJECT_EVIDENCE_SCHEMA",
  );
  const evidenceOutputPath = requiredEnvironment(
    "CHRONORIFT_TEST_EVIDENCE_OUTPUT",
  );
  const taskStorageRoot = requiredEnvironment(
    "CHRONORIFT_TEST_TASK_STORAGE_ROOT",
  );
  const cgroupRoot = requiredEnvironment("CHRONORIFT_TEST_CGROUP_ROOT");
  const nodePath = requiredEnvironment("CHRONORIFT_TEST_NODE_BIN");
  const godotPath = requiredEnvironment("CHRONORIFT_TEST_GODOT_BIN");
  const lifecycleAddonRoot = requiredEnvironment(
    "CHRONORIFT_TEST_GODOT_LIFECYCLE_ADDON_ROOT",
  );
  const runnerTemporaryRoot = requiredEnvironment("RUNNER_TEMP");
  const repositoryRoot = requiredEnvironment("GITHUB_WORKSPACE");
  const bwrapPath = requiredEnvironment("CHRONORIFT_TEST_BWRAP_BIN");
  const prlimitPath = requiredEnvironment("CHRONORIFT_TEST_PRLIMIT_BIN");
  const busyboxPath = requiredEnvironment("CHRONORIFT_TEST_BUSYBOX_BIN");
  const lddPath = requiredEnvironment("CHRONORIFT_TEST_LDD_BIN");
  const fontconfigProbePath = requiredEnvironment(
    "CHRONORIFT_TEST_FONTCONFIG_PROBE_BIN",
  );
  const xdgUserDirPath = requiredEnvironment(
    "CHRONORIFT_TEST_XDG_USER_DIR_BIN",
  );
  const bashPath = requiredEnvironment("CHRONORIFT_TEST_BASH_BIN");
  const rgPath = requiredEnvironment("CHRONORIFT_TEST_RG_BIN");
  const findPath = requiredEnvironment("CHRONORIFT_TEST_FIND_BIN");
  const lsPath = requiredEnvironment("CHRONORIFT_TEST_LS_BIN");
  for (const [label, path] of [
    ["source", sourceRoot],
    ["descriptor", descriptorPath],
    ["conformance spec", conformanceSpecPath],
    ["evidence schema", evidenceSchemaPath],
    ["Task storage", taskStorageRoot],
    ["delegated cgroup", cgroupRoot],
    ["managed Node", nodePath],
    ["managed Godot", godotPath],
    ["lifecycle addon", lifecycleAddonRoot],
    ["runner temporary root", runnerTemporaryRoot],
    ["repository", repositoryRoot],
    ["bubblewrap", bwrapPath],
    ["prlimit", prlimitPath],
    ["busybox", busyboxPath],
    ["ldd", lddPath],
    ["fontconfig probe", fontconfigProbePath],
    ["xdg-user-dir", xdgUserDirPath],
    ["bash", bashPath],
    ["ripgrep", rgPath],
    ["find", findPath],
    ["ls", lsPath],
  ] as const) {
    expect(await realpath(path), `${label} path must be canonical`).toBe(path);
  }
  await expectMissing(evidenceOutputPath);

  const [descriptorBytes, specBytes, evidenceSchemaBytes] = await Promise.all([
    readFile(descriptorPath),
    readFile(conformanceSpecPath),
    readFile(evidenceSchemaPath),
  ]);
  expect(sha256(descriptorBytes)).toBe(FROZEN_DESCRIPTOR_SHA256);
  expect(sha256(specBytes)).toBe(FROZEN_SPEC_SHA256);
  expect(evidenceSchemaBytes.byteLength).toBeGreaterThan(0);
  expect(evidenceSchemaBytes.byteLength).toBeLessThanOrEqual(65_536);
  const descriptorSnapshot =
    await readGodotProjectDescriptorSnapshotV1(descriptorPath);
  expect(descriptorSnapshot.descriptorSha256).toBe(FROZEN_DESCRIPTOR_SHA256);
  const spec = ConformanceSpecV1Schema.parse(
    JSON.parse(specBytes.toString("utf8")) as unknown,
  );

  expect(await git(sourceRoot, ["rev-parse", "HEAD"])).toBe(
    spec.source.headCommit,
  );
  expect(await git(sourceRoot, ["rev-parse", "HEAD^{tree}"])).toBe(
    spec.source.gitTreeObjectId,
  );
  expect(
    await git(sourceRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignored=matching",
    ]),
  ).toBe("");

  return Object.freeze({
    sourceRoot,
    descriptorPath,
    descriptorBytes,
    descriptorSnapshot,
    conformanceSpecPath,
    evidenceSchemaPath,
    evidenceOutputPath,
    taskStorageRoot,
    cgroupRoot,
    nodePath,
    godotPath,
    lifecycleAddonRoot,
    runnerTemporaryRoot,
    repositoryRoot,
    bwrapPath,
    prlimitPath,
    busyboxPath,
    lddPath,
    fontconfigProbePath,
    xdgUserDirPath,
    bashPath,
    rgPath,
    findPath,
    lsPath,
    spec,
  });
};

type FrozenInputs = Awaited<ReturnType<typeof loadFrozenInputs>>;

interface LifecycleTurnEvidence {
  readonly toolNames: readonly string[];
  readonly capabilities: LifecycleGameCapabilitiesOutputV2;
  readonly launch: LifecycleGameLaunchOutputV2;
  readonly status: LifecycleGameStatusOutputV2;
  readonly stop: LifecycleGameStopOutputV2;
}

const invokeLifecycleTool = async <Schema extends TSchema>(
  request: RunVNextPiSdkTurnOptions,
  turn: number,
  toolName: LifecycleGameToolNameV1,
  input: unknown,
  outputSchema: Schema,
): Promise<Static<Schema>> => {
  const tool = request.tools.find((candidate) => candidate.name === toolName);
  if (tool === undefined) throw new Error(`missing ${toolName}`);
  const toolCallId = `m4-turn-${String(turn)}-${toolName}`;
  const result = await tool.execute(
    toolCallId,
    input as never,
    undefined,
    undefined,
    {} as never,
  );
  const response: unknown = result.details;
  if (!Check(VNextGameToolResponseV1Schema, response)) {
    throw new Error(`${toolName} returned an invalid response envelope`);
  }
  if (response.toolCallId !== toolCallId || response.outcome !== "success") {
    const details =
      response.outcome === "error" ? response.error.details : null;
    const detailRecord =
      details !== null &&
      details !== undefined &&
      typeof details === "object" &&
      !Array.isArray(details)
        ? (details as Record<string, unknown>)
        : null;
    const stage =
      detailRecord !== null && typeof detailRecord["stage"] === "string"
        ? detailRecord["stage"]
        : "withheld";
    const code =
      response.outcome === "error" ? response.error.code : "envelope_mismatch";
    throw new Error(
      `${toolName} did not complete successfully (${code}; stage=${stage})`,
    );
  }
  if (!Check(outputSchema, response.output)) {
    throw new Error(`${toolName} returned invalid lifecycle output`);
  }
  return response.output;
};

const createDeterministicFakePi =
  (input: {
    readonly taskId: ReturnType<typeof asTaskId>;
    readonly markerPath: string;
    readonly markerContent: string;
    readonly turns: LifecycleTurnEvidence[];
  }) =>
  async (request: RunVNextPiSdkTurnOptions): Promise<VNextPiTurnResult> => {
    const turn = input.turns.length + 1;
    const toolNames = request.tools.map((tool) => tool.name);
    expect(toolNames).toEqual(EXPECTED_ACTIVE_TOOLS);
    expect(request.additionalEnvironmentInstructions).toContain(
      "lifecycle-only game tools",
    );
    if (turn === 1) {
      expect(request.resumeSessionFile).toBeUndefined();
    } else {
      expect(request.resumeSessionFile).toBeDefined();
    }

    const capabilities = await invokeLifecycleTool(
      request,
      turn,
      "game_capabilities",
      { schemaVersion: 2, taskId: input.taskId },
      LifecycleGameCapabilitiesOutputV2Schema,
    );
    const launch = await invokeLifecycleTool(
      request,
      turn,
      "game_launch",
      {
        schemaVersion: 2,
        taskId: input.taskId,
        buildId: capabilities.build.buildId,
      },
      LifecycleGameLaunchOutputV2Schema,
    );
    const status = await invokeLifecycleTool(
      request,
      turn,
      "game_status",
      {
        schemaVersion: 2,
        taskId: input.taskId,
        runtimeId: launch.runtime.runtimeId,
      },
      LifecycleGameStatusOutputV2Schema,
    );
    const stop = await invokeLifecycleTool(
      request,
      turn,
      "game_stop",
      {
        schemaVersion: 2,
        taskId: input.taskId,
        runtimeId: launch.runtime.runtimeId,
      },
      LifecycleGameStopOutputV2Schema,
    );
    if (turn === 1) {
      const writeTool = request.tools.find((tool) => tool.name === "write");
      if (writeTool === undefined) throw new Error("missing write tool");
      const writeResult = await writeTool.execute(
        "m4-turn-1-write-marker",
        { path: input.markerPath, content: input.markerContent },
        undefined,
        undefined,
        {} as never,
      );
      expect(JSON.stringify(writeResult.content)).toContain(
        "Successfully wrote",
      );
    }
    input.turns.push({ toolNames, capabilities, launch, status, stop });

    const sessionFile =
      request.resumeSessionFile ??
      join(request.sessionDirectory, "session.jsonl");
    await writeFile(
      sessionFile,
      `deterministic fake Pi turn ${String(turn)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    return {
      schemaVersion: 1,
      status: "completed",
      sessionId: "session-m4-external-project-conformance",
      sessionFile,
      provider: request.provider,
      model: request.model,
      requestedThinkingLevel: request.thinkingLevel,
      realizedThinkingLevel: request.thinkingLevel,
      activeTools: toolNames,
      assistantText: `deterministic M4 conformance turn ${String(turn)}`,
      errorMessage: null,
      eventsObserved: 0,
      observedTurnCount: 1,
      stats: {
        sessionFile,
        sessionId: "session-m4-external-project-conformance",
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: turn === 1 ? 5 : 4,
        toolResults: turn === 1 ? 5 : 4,
        totalMessages: turn === 1 ? 12 : 10,
        tokens: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
        cost: 0,
      },
    };
  };

const managedRuntimeInput = (inputs: FrozenInputs) => ({
  nodePath: inputs.nodePath,
  godotPath: inputs.godotPath,
  fontconfigProbePath: inputs.fontconfigProbePath,
  shellPath: inputs.busyboxPath,
  xdgUserDirPath: inputs.xdgUserDirPath,
  lddPath: inputs.lddPath,
  addonRoot: inputs.lifecycleAddonRoot,
  vanillaSidecarSource: createLifecycleVanillaSmokeSidecarSource({
    godotExecutable: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.godotExecutable,
    workspaceRoot: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.workspaceRoot,
    runtimeRoot: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.runtimeRoot,
  }),
  lifecycleSidecarSource: createLifecycleRuntimeSidecarSource({
    godotExecutable: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.godotExecutable,
    workspaceRoot: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.workspaceRoot,
    runtimeRoot: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.runtimeRoot,
  }),
});

const sandboxHostInput = (inputs: FrozenInputs) => ({
  delegatedCgroupRoot: inputs.cgroupRoot,
  bwrapPath: inputs.bwrapPath,
  prlimitPath: inputs.prlimitPath,
  busyboxPath: inputs.busyboxPath,
  taskStorageRoot: inputs.taskStorageRoot,
});

const sandboxToolchainInput = (inputs: FrozenInputs) => ({
  lddPath: inputs.lddPath,
  commands: [
    { target: "/bin/bash", hostPath: inputs.bashPath },
    { target: "/usr/bin/find", hostPath: inputs.findPath },
    { target: "/usr/bin/ls", hostPath: inputs.lsPath },
    { target: "/usr/bin/rg", hostPath: inputs.rgPath },
  ],
});

const phaseNamed = (
  record: VNextLifecycleExecutionRecordV1,
  phaseName: VNextLifecyclePhaseReceiptV1["phase"],
  occurrence = 0,
): VNextLifecyclePhaseReceiptV1 => {
  const phase = record.phases.filter((entry) => entry.phase === phaseName)[
    occurrence
  ];
  if (phase === undefined) throw new Error(`missing ${phaseName} phase`);
  return phase;
};

const ProcessOutputEventPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("process_output"),
    phase: z.enum(["import", "vanilla", "managed_import", "managed"]),
    stream: z.enum(["stdout", "stderr"]),
    offset: z.number().int().nonnegative(),
    byteLength: z.number().int().positive(),
    sha256: z.string().regex(SHA256),
    bytesBase64: z.string().min(1),
    occurrenceTimingBasis: z.literal("operation_envelope"),
    phaseHostMonotonicStartUs: z.number().int().nonnegative(),
    phaseHostMonotonicEndUs: z.number().int().nonnegative(),
    timingBasis: z.literal("last_sample_before_ingest"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.phaseHostMonotonicEndUs < value.phaseHostMonotonicStartUs) {
      context.addIssue({
        code: "custom",
        path: ["phaseHostMonotonicEndUs"],
        message: "diagnostic operation envelope cannot run backwards",
      });
    }
  });

const assertPersistedDiagnosticBytes = (
  record: VNextLifecycleExecutionRecordV1,
): void => {
  const chunks = record.events.flatMap((event) => {
    const parsed = ProcessOutputEventPayloadSchema.safeParse(event.payload);
    return parsed.success ? [parsed.data] : [];
  });
  const retainedByGroup = new Map<string, Buffer>();
  for (const phase of [
    "import",
    "vanilla",
    "managed_import",
    "managed",
  ] as const) {
    for (const stream of ["stdout", "stderr"] as const) {
      const selected = chunks
        .filter((chunk) => chunk.phase === phase && chunk.stream === stream)
        .sort((left, right) => left.offset - right.offset);
      let expectedOffset = 0;
      const buffers = selected.map((chunk) => {
        expect(chunk.offset).toBe(expectedOffset);
        const bytes = Buffer.from(chunk.bytesBase64, "base64");
        expect(bytes.toString("base64")).toBe(chunk.bytesBase64);
        expect(bytes.byteLength).toBe(chunk.byteLength);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          chunk.sha256,
        );
        expectedOffset += bytes.byteLength;
        return bytes;
      });
      retainedByGroup.set(`${phase}:${stream}`, Buffer.concat(buffers));
    }
  }
  for (const [phaseName, diagnosticPhase] of [
    ["vanilla_import", "import"],
    ["vanilla_smoke", "vanilla"],
    ["managed_import", "managed_import"],
    ["managed_stop", "managed"],
  ] as const) {
    const phase = phaseNamed(record, phaseName);
    for (const stream of ["stdout", "stderr"] as const) {
      const retained = retainedByGroup.get(`${diagnosticPhase}:${stream}`);
      if (retained === undefined) {
        throw new Error(`missing ${diagnosticPhase} ${stream} reconstruction`);
      }
      const receipt = phase[stream];
      expect(retained.byteLength).toBe(receipt.retainedBytes);
      expect(createHash("sha256").update(retained).digest("hex")).toBe(
        receipt.retainedSha256,
      );
    }
  }
  for (const [channel, stream] of [
    ["log", "stdout"],
    ["error", "stderr"],
  ] as const) {
    const coverage = record.coverage.find((entry) => entry.channel === channel);
    expect(coverage?.emittedRecords).toBe(
      chunks.filter((chunk) => chunk.stream === stream).length,
    );
  }
};

const assertLifecycleRecord: (
  record: VNextLifecycleExecutionRecordV1,
  expectedCandidateHash: string,
) => asserts record is Extract<
  VNextLifecycleExecutionRecordV1,
  { readonly sealed: true }
> = (record, expectedCandidateHash) => {
  expect(record.sealed).toBe(true);
  if (!record.sealed) throw new Error("lifecycle execution remained unsealed");
  expect(record.status).toBe("stopped");
  expect(record.phases.map((phase) => phase.phase)).toEqual(EXPECTED_PHASES);
  expect(record.phases.map((phase) => phase.sequence)).toEqual([
    0, 1, 2, 3, 4, 5, 6,
  ]);
  expect(record.manifest.identities.sourceSha256).toBe(expectedCandidateHash);
  expect(
    record.loss
      .filter((entry) => entry.channel === "clock" || entry.channel === "probe")
      .map((entry) => [entry.channel, entry.kind]),
  ).toEqual([
    ["clock", "sampled"],
    ["clock", "observer_effect"],
    ["probe", "sampled"],
    ["probe", "observer_effect"],
  ]);
  expect(
    record.loss.filter(
      (entry) => entry.channel === "log" || entry.channel === "error",
    ),
  ).toEqual([]);
  expect(record.coverage).toHaveLength(4);
  expect(record.coverage.map((entry) => entry.channel).sort()).toEqual([
    "clock",
    "error",
    "log",
    "probe",
  ]);
  assertPersistedDiagnosticBytes(record);
  for (const phase of record.phases) {
    expect(phase.hostMonotonicEndUs).toBeGreaterThanOrEqual(
      phase.hostMonotonicStartUs,
    );
    expect(phase.stdout.truncated).toBe(false);
    expect(phase.stderr.truncated).toBe(false);
    expect(phase.stdout.retainedBytes).toBe(phase.stdout.totalBytes);
    expect(phase.stderr.retainedBytes).toBe(phase.stderr.totalBytes);
  }
  const vanilla = phaseNamed(record, "vanilla_smoke");
  const handshake = phaseNamed(record, "managed_handshake");
  const explicitStatus = phaseNamed(record, "managed_status", 1);
  const stop = phaseNamed(record, "managed_stop");
  expect(vanilla.outcome).toBe("controlled_stop");
  expect(vanilla.cleanup).not.toBeNull();
  expect(
    vanilla.cleanup === null ? false : lifecycleCleanupProven(vanilla.cleanup),
  ).toBe(true);
  expect(handshake.observation).toMatchObject({
    engineVersion: "4.7.1-stable (official)",
    platform: "Linux",
    renderer: "gl_compatibility",
    configuredScene: "uid://dhcpt1kt8cs0g",
    currentScene: "res://main.tscn",
  });
  expect(handshake.observation?.processFrameDelta).toBeGreaterThanOrEqual(120);
  expect(handshake.observation?.physicsTickDelta).toBeGreaterThanOrEqual(120);
  expect(
    explicitStatus.observation?.clock.hostMonotonicUs,
  ).toBeGreaterThanOrEqual(handshake.observation?.clock.hostMonotonicUs ?? 0);
  expect(stop.outcome).toBe("controlled_stop");
  expect(stop.cleanup).not.toBeNull();
  expect(
    stop.cleanup === null ? false : lifecycleCleanupProven(stop.cleanup),
  ).toBe(true);
};

const assertExternalSourceUnchanged = async (
  inputs: FrozenInputs,
): Promise<void> => {
  expect(await git(inputs.sourceRoot, ["rev-parse", "HEAD"])).toBe(
    inputs.spec.source.headCommit,
  );
  expect(await git(inputs.sourceRoot, ["rev-parse", "HEAD^{tree}"])).toBe(
    inputs.spec.source.gitTreeObjectId,
  );
  expect(
    await git(inputs.sourceRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignored=matching",
    ]),
  ).toBe("");
};

const publishEvidence = async (
  inputs: FrozenInputs,
  evidence: unknown,
): Promise<void> => {
  const pendingPath = `${inputs.evidenceOutputPath}.pending-${String(process.pid)}`;
  await expectMissing(pendingPath);
  const handle = await open(pendingPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(evidence)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await execFileAsync(
      inputs.nodePath,
      [
        join(
          inputs.repositoryRoot,
          ".github/scripts/validate-vnext-external-project-evidence.mjs",
        ),
        inputs.evidenceSchemaPath,
        pendingPath,
      ],
      {
        cwd: inputs.repositoryRoot,
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      },
    );
    await rename(pendingPath, inputs.evidenceOutputPath);
  } catch (error) {
    await rm(pendingPath, { force: true });
    throw error;
  }
};

describe("frozen moddable-platformer M4 external-project conformance", () => {
  it("runs the normal Task lifecycle and emits evidence only after real cleanup", async () => {
    const inputs = await loadFrozenInputs();
    expect(inputs.spec.candidatePatch.selectedTreeSha256).toMatch(SHA256);
    expect(inputs.spec.candidatePatch.selectedTreeSha256).toBe(
      FROZEN_CANDIDATE_SHA256,
    );
    expect(sha256(Buffer.from(inputs.spec.candidatePatch.contentUtf8))).toBe(
      FROZEN_MARKER_CONTENT_SHA256,
    );

    const networkInterfaces = (await readFile("/proc/net/dev", "utf8"))
      .split("\n")
      .slice(2)
      .map((line) => line.split(":", 1)[0]?.trim())
      .filter((name): name is string => name !== undefined && name !== "");
    expect(networkInterfaces).toEqual(["lo"]);
    const delegatedControllers = (
      await readFile(join(inputs.cgroupRoot, "cgroup.subtree_control"), "utf8")
    )
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
      .sort();
    expect(delegatedControllers).toEqual(["cpu", "memory", "pids"]);
    const storageFacts = await statfs(inputs.taskStorageRoot);
    expect(storageFacts.type).toBe(0x01_02_19_94);
    const storageCapacityBytes = storageFacts.blocks * storageFacts.bsize;
    const storageInodeCapacity = storageFacts.files;
    expect(storageCapacityBytes).toBeGreaterThan(0);
    expect(storageCapacityBytes).toBeLessThanOrEqual(1_073_741_824);
    expect(storageInodeCapacity).toBeGreaterThan(0);
    expect(storageInodeCapacity).toBeLessThanOrEqual(131_072);
    expect(await readdir(inputs.taskStorageRoot)).toEqual([]);

    const taskId = asTaskId("task:m4-external-project-conformance");
    const runtimeRoot = await mkdtemp(
      join(inputs.taskStorageRoot, "chronorift-m4-runtime-"),
    );
    const exportRoot = await mkdtemp(
      join(inputs.runnerTemporaryRoot, "chronorift-m4-export-"),
    );
    const managedGodotLifecycleRuntime = managedRuntimeInput(inputs);
    const sandboxHost = sandboxHostInput(inputs);
    const sandboxToolchain = sandboxToolchainInput(inputs);
    const resumeRequest = {
      taskId,
      runtimeRoot,
      sandboxHost,
      sandboxToolchain,
      managedGodotLifecycleRuntime,
    } as const;
    const turns: LifecycleTurnEvidence[] = [];
    const runTurn = createDeterministicFakePi({
      taskId,
      markerPath: inputs.spec.candidatePatch.relativePath,
      markerContent: inputs.spec.candidatePatch.contentUtf8,
      turns,
    });
    let startAttempted = false;
    let discarded = false;
    let runtimeRootRemoved = false;
    let bodyFailure: unknown;

    try {
      startAttempted = true;
      const started = await startVNextAgentTask(
        {
          taskId,
          projectPath: inputs.sourceRoot,
          externalProjectDescriptor: inputs.descriptorSnapshot,
          runtimeRoot,
          sandboxHost,
          sandboxToolchain,
          managedGodotLifecycleRuntime,
          goal: "Add the frozen onboarding marker and exercise the external Godot lifecycle",
          provider: "chronorift-conformance",
          model: "deterministic-fake-pi",
          thinkingLevel: "off",
        },
        { runTurn },
      );
      const continued = await continueVNextAgentTask(
        {
          ...resumeRequest,
          prompt:
            "Re-open the persisted Task profile and repeat the lifecycle observation",
        },
        { runTurn },
      );
      const shown = await showVNextAgentTask({ taskId, runtimeRoot });
      const exportReceipt = await exportVNextAgentTaskPatch({
        ...resumeRequest,
        hostCwd: exportRoot,
        outputPath: "candidate.patch",
      });

      expect(started).toMatchObject({
        taskId,
        turn: 1,
        loopStatus: "completed",
        activeTools: EXPECTED_ACTIVE_TOOLS,
      });
      expect(continued).toMatchObject({
        taskId,
        turn: 2,
        loopStatus: "completed",
        activeTools: EXPECTED_ACTIVE_TOOLS,
      });
      expect(turns).toHaveLength(2);
      expect(turns.map((turn) => turn.toolNames)).toEqual([
        EXPECTED_ACTIVE_TOOLS,
        EXPECTED_ACTIVE_TOOLS,
      ]);
      for (const [turnIndex, turn] of turns.entries()) {
        expect(
          (turn.capabilities.tools as readonly { readonly name: string }[]).map(
            (tool) => tool.name,
          ),
        ).toEqual(LIFECYCLE_GAME_TOOL_NAMES_V1);
        expect(turn.capabilities.runtime).toBeNull();
        const expectedTurnSourceHash =
          turnIndex === 0
            ? inputs.spec.source.selectedTreeSha256
            : FROZEN_CANDIDATE_SHA256;
        expect(turn.capabilities.build.sourceHash).toBe(expectedTurnSourceHash);
        expect(turn.launch.build.sourceHash).toBe(expectedTurnSourceHash);
        expect(turn.launch.phases.map((phase) => phase.phase)).toEqual(
          EXPECTED_PHASES.slice(0, 5),
        );
        expect(turn.launch.runtime.status).toBe("running");
        expect(turn.status.runtime.status).toBe("running");
        expect(
          turn.status.runtime.clocks.hostMonotonicUs,
        ).toBeGreaterThanOrEqual(turn.launch.runtime.clocks.hostMonotonicUs);
        expect(turn.stop).toMatchObject({
          sealed: true,
          runtime: { status: "stopped" },
          cleanup: {
            processGroupTerminated: true,
            godotExited: true,
            sidecarExited: true,
            cgroupEmpty: true,
            scopeRemoved: true,
            scratchRemoved: true,
            storageReconciled: true,
          },
        });
      }

      expect(shown.task).toMatchObject({
        schemaVersion: 3,
        taskId,
        profile: {
          kind: "godot-external-lifecycle-v1",
          toolNames: LIFECYCLE_GAME_TOOL_NAMES_V1,
        },
      });
      expect(shown.turns).toHaveLength(2);
      expect(shown.runtimeResources.executions).toHaveLength(2);
      expect(
        shown.runtimeResources.executions.every((entry) => entry.sealed),
      ).toBe(true);
      const shownJson = JSON.stringify(shown);
      for (const secretPath of [
        inputs.sourceRoot,
        inputs.taskStorageRoot,
        inputs.lifecycleAddonRoot,
        inputs.repositoryRoot,
      ]) {
        expect(shownJson).not.toContain(secretPath);
      }

      const taskStore = new VNextTaskStore(runtimeRoot);
      await taskStore.create(taskId);
      const [
        persistedDescriptor,
        projectCapability,
        managedCapability,
        policy,
        sandboxCapability,
        patchIdentity,
        patchBytes,
      ] = await Promise.all([
        taskStore.readBytes(taskId, "project-descriptor.json"),
        taskStore.readJson(taskId, "project-capability.json", (value) =>
          TaskGodotProjectCapabilityV1Schema.parse(value),
        ),
        taskStore.readJson(taskId, "managed-lifecycle-runtime.json", (value) =>
          ManagedGodotLifecycleRuntimeCapabilityV1Schema.parse(value),
        ),
        taskStore.readJson(taskId, "sandbox-policy.json", (value) =>
          SandboxPolicySchema.parse(value),
        ),
        taskStore.readJson(taskId, "sandbox-capability.json", (value) =>
          SandboxHostCapabilityV1Schema.parse(value),
        ),
        taskStore.readJson(taskId, "patch.json", (value) =>
          TaskPatchIdentityV1Schema.parse(value),
        ),
        taskStore.readBytes(taskId, "patch.diff"),
      ]);
      expect(Buffer.from(persistedDescriptor)).toEqual(inputs.descriptorBytes);
      expect(projectCapability).toMatchObject({
        descriptorSha256: FROZEN_DESCRIPTOR_SHA256,
        sourceRevision: inputs.spec.source.headCommit,
        baselineSelectedTreeSha256: inputs.spec.source.selectedTreeSha256,
      });
      expect(managedCapability).toMatchObject({
        runtimeProfile: "chronorift-managed-godot-lifecycle-v1",
        doctorVersion: "4.7.1.stable.official.a13da4feb",
        engineVersion: "4.7.1-stable (official)",
      });
      expect(policy).toMatchObject({
        schemaVersion: 2,
        network: "isolated",
        copiedEnvironmentKeys: ["CI", "NO_COLOR"],
        profileBindings: {
          "godot-headless": { workspaceAccess: "read-only" },
        },
      });
      if (policy.schemaVersion !== 2) {
        throw new Error("M4 requires the dual-profile sandbox policy");
      }
      expect(sandboxCapability.controllers).toEqual(["cpu", "memory", "pids"]);
      expect(sandboxCapability.taskStorage).toMatchObject({
        filesystem: "tmpfs",
        totalBytes: storageCapacityBytes,
        totalInodes: storageInodeCapacity,
      });
      expect(patchIdentity).toMatchObject({
        baselineSourceHash: inputs.spec.source.selectedTreeSha256,
        candidateSourceHash: FROZEN_CANDIDATE_SHA256,
        patchHash: exportReceipt.patchSha256,
      });
      expect(sha256(patchBytes)).toBe(exportReceipt.patchSha256);

      const sandboxOperationRecords = await taskStore.readLedger(
        taskId,
        "sandbox-operations.jsonl",
        (value) => SandboxOperationRecordV1Schema.parse(value),
      );
      expect(sandboxOperationRecords.length).toBeGreaterThan(0);
      const mountAdmissions = sandboxOperationRecords.map((record) => {
        const admission = record.receipt.mountAdmission;
        if (admission === undefined) {
          throw new Error(
            `sandbox operation ${record.receipt.operationId} has no validated mount admission`,
          );
        }
        return admission;
      });
      const godotMountAdmissions = sandboxOperationRecords.flatMap((record) =>
        record.receipt.requested.profile === "godot-headless" &&
        record.receipt.mountAdmission !== undefined
          ? [record.receipt.mountAdmission]
          : [],
      );
      expect(godotMountAdmissions.length).toBeGreaterThan(0);
      const sourceMountedReadOnly = godotMountAdmissions.every(
        (admission) => admission.workspaceAccess === "read-only",
      );
      const taskCredentialMountCount = mountAdmissions.reduce(
        (total, admission) => total + admission.credentialTargetCount,
        0,
      );
      expect(sourceMountedReadOnly).toBe(true);
      expect(taskCredentialMountCount).toBe(0);
      expect(
        mountAdmissions.every(
          (admission) =>
            JSON.stringify(admission.taskSharedWritableTargets) ===
            JSON.stringify(["/tmp", "/artifacts"]),
        ),
      ).toBe(true);
      const serializedAdmissions = JSON.stringify(mountAdmissions);
      for (const secretPath of [
        inputs.sourceRoot,
        inputs.taskStorageRoot,
        inputs.lifecycleAddonRoot,
        inputs.repositoryRoot,
      ]) {
        expect(serializedAdmissions).not.toContain(secretPath);
      }
      const mountAdmissionsSha256 = contentHash(
        sandboxOperationRecords.map((record) => ({
          operationId: record.receipt.operationId,
          status: record.receipt.status,
          mountAdmission: record.receipt.mountAdmission,
        })) as unknown as JsonValue,
      );

      const exportedPatch = await readFile(
        join(exportRoot, exportReceipt.outputPath),
      );
      expect(exportedPatch).toEqual(Buffer.from(patchBytes));
      expect(exportReceipt).toMatchObject({
        taskId,
        outputPath: "candidate.patch",
        status: "completed",
        byteLength: exportedPatch.byteLength,
      });
      const exportedPatchText = exportedPatch.toString("utf8");
      expect(exportedPatchText).toContain("new file mode 100644");
      expect(exportedPatchText).toContain(
        "+++ b/CHRONORIFT_ONBOARDING_SMOKE.md",
      );
      expect(exportedPatchText).toContain(
        "+ChronoRift external-project onboarding conformance.",
      );

      const runtimeStore = new VNextRuntimeStore(runtimeRoot);
      await runtimeStore.open(taskId);
      const executionIds = turns.map((turn) => turn.launch.runtime.executionId);
      expect(new Set(executionIds).size).toBe(2);
      const records = await Promise.all(
        executionIds.map((executionId) =>
          runtimeStore.readResource(taskId, "execution", executionId, (value) =>
            VNextLifecycleExecutionRecordV1Schema.parse(value),
          ),
        ),
      );
      const physicalExecutionSeals = await Promise.all(
        executionIds.map((executionId) =>
          runtimeStore.readExecutionSeal(taskId, executionId),
        ),
      );
      for (const [index, record] of records.entries()) {
        const physicalSeal = physicalExecutionSeals[index];
        if (physicalSeal === undefined) {
          throw new Error("missing physical lifecycle execution seal");
        }
        expect(record.manifest.executionSeal).toEqual(physicalSeal);
        expect(physicalSeal).toMatchObject({
          taskId,
          executionId: record.executionId,
          count: record.events.length,
        });
      }
      const baselineRecord = records[0];
      const candidateRecord = records[1];
      if (baselineRecord === undefined || candidateRecord === undefined) {
        throw new Error("missing lifecycle execution record");
      }
      assertLifecycleRecord(
        baselineRecord,
        inputs.spec.source.selectedTreeSha256,
      );
      assertLifecycleRecord(candidateRecord, FROZEN_CANDIDATE_SHA256);
      const evidenceRecord = records[1];
      if (evidenceRecord === undefined || !evidenceRecord.sealed) {
        throw new Error("missing second sealed lifecycle execution");
      }
      const importPhase = phaseNamed(evidenceRecord, "vanilla_import");
      const vanillaPhase = phaseNamed(evidenceRecord, "vanilla_smoke");
      const handshakePhase = phaseNamed(evidenceRecord, "managed_handshake");
      const stopPhase = phaseNamed(evidenceRecord, "managed_stop");
      expect(importPhase).toMatchObject({
        outcome: "succeeded",
        exitCode: 0,
        signal: null,
      });
      expect(vanillaPhase.stabilityObservedMs).toBeGreaterThanOrEqual(
        inputs.spec.runtimeExpectations.vanillaStableMinimumMs,
      );
      const observation = handshakePhase.observation;
      if (observation === null) {
        throw new Error("managed handshake has no observation");
      }
      expect(observation.processFrameDelta).toBeGreaterThanOrEqual(
        inputs.spec.runtimeExpectations.minimumProcessFrames,
      );
      expect(observation.physicsTickDelta).toBeGreaterThanOrEqual(
        inputs.spec.runtimeExpectations.minimumPhysicsTicks,
      );

      const discardReceipt = await discardVNextAgentTask(resumeRequest);
      expect(discardReceipt).toMatchObject({
        processGroupTerminated: true,
        cgroupPopulated: false,
        scopeRemoved: true,
      });
      discarded = true;
      await rm(runtimeRoot, { recursive: true });
      runtimeRootRemoved = true;
      expect(await readdir(inputs.taskStorageRoot)).toEqual([]);
      const remainingCgroups = (
        await readdir(inputs.cgroupRoot, {
          withFileTypes: true,
        })
      ).filter((entry) => entry.isDirectory());
      expect(remainingCgroups).toEqual([]);
      await assertExternalSourceUnchanged(inputs);

      const evidence = {
        schemaVersion: 1,
        evidenceKind: "chronorift-m4-external-project-conformance-evidence",
        conformanceSpecSha256: FROZEN_SPEC_SHA256,
        profile: "chronorift-godot-lifecycle-v1",
        driver: {
          kind: "deterministic-fake-pi",
          providerContacted: false,
        },
        source: {
          declaredSourceUrl: inputs.spec.source.declaredUrl,
          headCommit: inputs.spec.source.headCommit,
          gitTreeObjectId: inputs.spec.source.gitTreeObjectId,
          selectedTreeSha256: inputs.spec.source.selectedTreeSha256,
          entryCount: inputs.spec.source.entryCount,
          declaredByteLength: inputs.spec.source.declaredByteLength,
          cleanBeforeTask: true,
          unchangedAfterTask: true,
        },
        descriptor: {
          sha256: FROZEN_DESCRIPTOR_SHA256,
          persistedBytesRevalidated: true,
        },
        toolchain: {
          nodeVersion: "v22.23.1",
          godotVersion: managedCapability.doctorVersion,
        },
        sandbox: {
          networkMode: "loopback_only",
          storageFilesystem: "tmpfs",
          storageCapacityBytes,
          storageInodeCapacity,
          delegatedControllers: ["cpu", "memory", "pids"],
          sourceMountedReadOnly,
          taskCredentialMountCount,
          mountAdmissionReceiptCount: mountAdmissions.length,
          mountAdmissionsSha256,
          taskSharedWritableTargets: ["/tmp", "/artifacts"],
        },
        lifecycleTools: {
          exposed: [...LIFECYCLE_GAME_TOOL_NAMES_V1],
          notExposed: NOT_EXPOSED_GAME_TOOLS,
        },
        taskLifecycle: {
          lifecycleOperationsObserved: [
            "start",
            "continue",
            "show",
            "export",
            "discard",
          ],
          profilePreservedOnContinue: true,
        },
        runtime: {
          import: {
            exitCode: importPhase.exitCode,
            timedOut: importPhase.outcome === "timed_out",
            durationMs: importPhase.processDurationMs,
            timingFidelity: importPhase.timingFidelity,
            stdout: diagnosticStream(importPhase.stdout),
            stderr: diagnosticStream(importPhase.stderr),
            receiptSha256: contentHash(importPhase as unknown as JsonValue),
          },
          vanilla: {
            stabilityObservedMs: vanillaPhase.stabilityObservedMs,
            timingFidelity: vanillaPhase.timingFidelity,
            timedOut: vanillaPhase.outcome === "timed_out",
            stoppedByHarness: vanillaPhase.outcome === "controlled_stop",
            stdout: diagnosticStream(vanillaPhase.stdout),
            stderr: diagnosticStream(vanillaPhase.stderr),
            receiptSha256: contentHash(vanillaPhase as unknown as JsonValue),
          },
          overlay: {
            protocolVersion: 1,
            handshakeObserved: true,
            addonSha256: managedCapability.addonHash,
            candidateSourceSha256:
              evidenceRecord.manifest.identities.sourceSha256,
            engineVersion: observation.engineVersion,
            platform: observation.platform,
            renderer: observation.renderer,
            configuredSceneMatched:
              observation.configuredScene === "uid://dhcpt1kt8cs0g",
            currentSceneMatched: observation.currentScene === "res://main.tscn",
            processFrameDelta: observation.processFrameDelta,
            physicsTickDelta: observation.physicsTickDelta,
            hostMonotonicStartUs: handshakePhase.hostMonotonicStartUs,
            hostMonotonicEndUs: handshakePhase.hostMonotonicEndUs,
            diagnosticLossObserved:
              evidenceRecord.loss.some(
                (entry) => entry.channel === "log" || entry.channel === "error",
              ) ||
              evidenceRecord.phases.some(
                (phase) => phase.stdout.truncated || phase.stderr.truncated,
              ),
            receiptSha256: contentHash(handshakePhase as unknown as JsonValue),
          },
          shutdown: {
            finalStatus: evidenceRecord.status,
            receiptSha256: contentHash(stopPhase as unknown as JsonValue),
          },
        },
        candidate: {
          relativePath: inputs.spec.candidatePatch.relativePath,
          mode: inputs.spec.candidatePatch.mode,
          contentSha256: FROZEN_MARKER_CONTENT_SHA256,
          baselineSelectedTreeSha256: patchIdentity.baselineSourceHash,
          candidateSelectedTreeSha256: patchIdentity.candidateSourceHash,
          exportedPatchSha256: exportReceipt.patchSha256,
          roundTripSelectedTreeSha256: patchIdentity.candidateSourceHash,
        },
        cleanup: {
          taskDiscarded: true,
          taskProcessesEmpty: discardReceipt.processGroupTerminated,
          taskCgroupsEmpty: remainingCgroups.length === 0,
          taskStorageEmpty:
            (await readdir(inputs.taskStorageRoot)).length === 0,
        },
      };
      await publishEvidence(inputs, evidence);
    } catch (error) {
      bodyFailure = error;
    }

    let cleanupFailure: unknown;
    if (!discarded && startAttempted) {
      try {
        const receipt = await discardVNextAgentTask(resumeRequest);
        if (
          !receipt.processGroupTerminated ||
          receipt.cgroupPopulated ||
          !receipt.scopeRemoved
        ) {
          throw new Error("failed Task retained sandbox resources");
        }
        discarded = true;
      } catch (error) {
        cleanupFailure = error;
      }
    }
    if (discarded && !runtimeRootRemoved) {
      try {
        await rm(runtimeRoot, { recursive: true });
        runtimeRootRemoved = true;
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    await rm(exportRoot, { recursive: true });
    if (bodyFailure !== undefined && cleanupFailure !== undefined) {
      throw new AggregateError(
        [bodyFailure, cleanupFailure],
        "M4 conformance failed and Task cleanup could not be proven",
      );
    }
    if (bodyFailure !== undefined) throw asError(bodyFailure);
    if (cleanupFailure !== undefined) throw asError(cleanupFailure);
    expect(discarded).toBe(true);
    expect(runtimeRootRemoved).toBe(true);
  });
});
