import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  CaptureWindowIdSchema,
  ProjectEnvironmentRuntimeObservationReceiptIdSchema,
  asAdapterId,
  asBuildId,
  asProjectEnvironmentId,
  asProjectEnvironmentTaskId,
  projectRuntimeCleanupCompleteV1,
} from "@chronorift/domain";
import { loadProjectAdapterPackageFilesV1 } from "@chronorift/godot-adapter";
import {
  ProjectEnvironmentStoreV1,
  ProjectEnvironmentTaskStoreV1,
} from "@chronorift/json-artifacts";
import type { PiThinkingLevel } from "@chronorift/pi-harness";
import { afterEach, describe, expect, it } from "vitest";

import { collectCandidateGodotSourceV1 } from "./candidate-godot-build.js";
import {
  readProjectEnvironmentHostConfigV1,
  type ProjectEnvironmentHostConfigV1,
} from "./project-environment-host-config.js";
import { buildProjectEnvironmentPeAEvidenceV1 } from "./project-environment-pe-a-evidence.js";
import {
  runProjectEnvironmentPreviewV1,
  type ProjectEnvironmentPreviewResultV1,
} from "./project-environment-preview.js";
import { inspectReusableProjectEnvironmentRevisionV1 } from "./project-environment-reuse.js";
import { preflightCleanProjectEnvironmentV1 } from "./source-preflight.js";

const execFileAsync = promisify(execFile);
const LIVE_GATE_MODE = process.env.CHRONORIFT_TEST_PE_A_LIVE;
if (
  LIVE_GATE_MODE !== undefined &&
  LIVE_GATE_MODE !== "0" &&
  LIVE_GATE_MODE !== "1"
) {
  throw new Error("CHRONORIFT_TEST_PE_A_LIVE must be exactly 0 or 1");
}
const LIVE_GATE_ENABLED = LIVE_GATE_MODE === "1";
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const TURN_TIMEOUT_MS = 600_000;
const OWNED_RUNTIME_PREFIX = "chronorift-pe-a-live-";
const EVIDENCE_VALIDATOR = resolve(
  ".github/scripts/validate-project-environment-pe-a-evidence.mjs",
);
const EVIDENCE_SCHEMA = resolve(
  "testdata/vnext/project-environment/pe-a-evidence-bundle.schema.v1.json",
);
const THINKING_LEVELS = new Set<PiThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const temporaryRoots: string[] = [];
const ownedRuntimeRoots: {
  readonly taskStorageRoot: string;
  readonly runtimeRoot: string;
}[] = [];

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (
    value === undefined ||
    value.trim().length === 0 ||
    value.length > 4_096 ||
    value.includes("\0")
  ) {
    throw new Error(`PE-A live Gate requires bounded ${name}`);
  }
  return value;
};

const requiredIdentifierEnvironment = (name: string): string => {
  const value = requiredEnvironment(name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(value)) {
    throw new Error(`PE-A live Gate requires a valid ${name} identifier`);
  }
  return value;
};

const requiredDirectoryEnvironment = async (name: string): Promise<string> => {
  const requested = resolve(requiredEnvironment(name));
  const canonical = await realpath(requested);
  if (canonical !== requested || !(await stat(canonical)).isDirectory()) {
    throw new Error(`PE-A live Gate requires canonical directory ${name}`);
  }
  return canonical;
};

const requestedThinkingLevel = (): PiThinkingLevel => {
  const value = requiredEnvironment("CHRONORIFT_TEST_PE_A_THINKING_LEVEL");
  if (!THINKING_LEVELS.has(value as PiThinkingLevel)) {
    throw new Error(
      "CHRONORIFT_TEST_PE_A_THINKING_LEVEL is not a supported Pi thinking level",
    );
  }
  return value as PiThinkingLevel;
};

const removeOwnedRuntimeRoot = async (input: {
  readonly taskStorageRoot: string;
  readonly runtimeRoot: string;
}): Promise<void> => {
  if (
    dirname(input.runtimeRoot) !== input.taskStorageRoot ||
    !basename(input.runtimeRoot).startsWith(OWNED_RUNTIME_PREFIX)
  ) {
    throw new Error("refusing to remove a non-owned PE-A live runtime root");
  }
  await rm(input.runtimeRoot, { recursive: true, force: true });
};

afterEach(async () => {
  const results = await Promise.allSettled([
    ...ownedRuntimeRoots.splice(0).map(removeOwnedRuntimeRoot),
    ...temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  ]);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
});

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const result = await execFileAsync("/usr/bin/git", [...args], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "ChronoRift PE-A Live",
      GIT_AUTHOR_EMAIL: "pe-a-live@chronorift.invalid",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "ChronoRift PE-A Live",
      GIT_COMMITTER_EMAIL: "pe-a-live@chronorift.invalid",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout;
};

const initializeFixtureRepository = async (
  projectRoot: string,
): Promise<void> => {
  const fixtureRoot = await realpath(
    join(process.cwd(), "fixtures/godot-project-environment-pe-a-live"),
  );
  await mkdir(projectRoot);
  await cp(fixtureRoot, projectRoot, { recursive: true });
  await git(projectRoot, ["init", "--quiet", "--initial-branch=main"]);
  await git(projectRoot, ["add", "--all"]);
  await git(projectRoot, ["commit", "--quiet", "-m", "frozen PE-A fixture"]);
  expect(await git(projectRoot, ["status", "--porcelain=v1"])).toBe("");
};

const writeIsolatedHostConfig = async (input: {
  readonly testRoot: string;
  readonly sourceConfigPath: string;
}): Promise<{
  readonly config: ProjectEnvironmentHostConfigV1;
  readonly path: string;
}> => {
  const sourceConfig = await readProjectEnvironmentHostConfigV1(
    await realpath(input.sourceConfigPath),
  );
  const runtimeRoot = join(
    sourceConfig.taskStorageRoot,
    `${OWNED_RUNTIME_PREFIX}${randomUUID()}`,
  );
  if (
    dirname(runtimeRoot) !== sourceConfig.taskStorageRoot ||
    relative(sourceConfig.taskStorageRoot, runtimeRoot).includes(sep)
  ) {
    throw new Error("PE-A live runtime root was not an owned direct child");
  }
  const config = Object.freeze({ ...sourceConfig, runtimeRoot });
  const path = join(input.testRoot, "project-environment-host.v1.json");
  await writeFile(path, `${JSON.stringify(config)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  ownedRuntimeRoots.push({
    taskStorageRoot: sourceConfig.taskStorageRoot,
    runtimeRoot,
  });
  return Object.freeze({ config, path: await realpath(path) });
};

interface ObservedToolCallV1 {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

interface CompatibleBuildEvidenceV1 {
  readonly build: Awaited<
    ReturnType<ProjectEnvironmentTaskStoreV1["readBuild"]>
  >;
  readonly binding: Awaited<
    ReturnType<ProjectEnvironmentTaskStoreV1["readBuildBinding"]>
  >;
  readonly compatibility: Awaited<
    ReturnType<ProjectEnvironmentTaskStoreV1["readCompatibilityReceipt"]>
  >;
}

interface ObservedToolResultV1 {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly isError: boolean;
  readonly details: unknown;
}

interface SessionTranscriptV1 {
  readonly header: Readonly<Record<string, unknown>>;
  readonly entries: readonly unknown[];
  readonly userMessageCount: number;
  readonly toolCalls: readonly ObservedToolCallV1[];
  readonly toolResults: readonly ObservedToolResultV1[];
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const readSessionTranscript = async (
  sessionFile: string,
): Promise<SessionTranscriptV1> => {
  const absolutePath = resolve(sessionFile);
  const metadata = await stat(absolutePath);
  if (
    !metadata.isFile() ||
    metadata.size < 1 ||
    metadata.size > MAX_SESSION_BYTES
  ) {
    throw new Error("PE-A live Pi Session file is not a bounded regular file");
  }
  const entries = (await readFile(absolutePath, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
  const header = asRecord(entries[0]);
  if (header === null || header.type !== "session") {
    throw new Error("PE-A live Pi Session header is missing");
  }
  const toolCalls: ObservedToolCallV1[] = [];
  const toolResults: ObservedToolResultV1[] = [];
  let userMessageCount = 0;
  for (const entry of entries.slice(1)) {
    const message = asRecord(asRecord(entry)?.message);
    if (message === null) continue;
    if (message.role === "user") userMessageCount += 1;
    if (
      message.role === "toolResult" &&
      typeof message.toolCallId === "string" &&
      typeof message.toolName === "string" &&
      typeof message.isError === "boolean"
    ) {
      toolResults.push(
        Object.freeze({
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          isError: message.isError,
          details: message.details,
        }),
      );
    }
    if (!Array.isArray(message.content)) continue;
    for (const rawPart of message.content) {
      const part = asRecord(rawPart);
      const args = asRecord(part?.arguments);
      if (
        part?.type === "toolCall" &&
        typeof part.id === "string" &&
        typeof part.name === "string"
      ) {
        if (args === null) {
          throw new Error("PE-A live Pi tool call arguments are malformed");
        }
        toolCalls.push(
          Object.freeze({
            id: part.id,
            name: part.name,
            arguments: Object.freeze(args),
          }),
        );
      }
    }
  }
  return Object.freeze({
    header: Object.freeze(header),
    entries: Object.freeze(entries),
    userMessageCount,
    toolCalls: Object.freeze(toolCalls),
    toolResults: Object.freeze(toolResults),
  });
};

const requireSessionFile = (
  result: ProjectEnvironmentPreviewResultV1,
): string => {
  if (result.sessionFile === null) {
    throw new Error("PE-A live Preview did not retain its Pi Session file");
  }
  return result.sessionFile;
};

const assertObservedExactBuild = (
  transcript: SessionTranscriptV1,
  buildId: string,
  expectedCounter: number,
  runtimeIdentity: { readonly runtimeId: string; readonly executionId: string },
): string => {
  const names = transcript.toolCalls.map((call) => call.name);
  expect(names).toEqual(
    expect.arrayContaining([
      "game_capabilities",
      "game_launch",
      "game_capture_configure",
      "game_capture_pin",
      "game_query",
      "game_stop",
    ]),
  );
  const exactLaunch = transcript.toolCalls.find((call) => {
    if (call.name !== "game_launch" || call.arguments.buildId !== buildId) {
      return false;
    }
    const result = transcript.toolResults.find(
      (candidate) => candidate.toolCallId === call.id,
    );
    const output = asRecord(asRecord(result?.details)?.output);
    return (
      output?.runtimeId === runtimeIdentity.runtimeId &&
      output.executionId === runtimeIdentity.executionId
    );
  });
  expect(exactLaunch).toBeDefined();
  const exactLaunchResult = transcript.toolResults.find(
    (result) => result.toolCallId === exactLaunch?.id,
  );
  const exactLaunchDetails = asRecord(exactLaunchResult?.details);
  const exactLaunchOutput = asRecord(exactLaunchDetails?.output);
  if (
    exactLaunchResult?.toolName !== "game_launch" ||
    exactLaunchResult.isError ||
    exactLaunchDetails?.outcome !== "success" ||
    typeof exactLaunchOutput?.runtimeId !== "string" ||
    typeof exactLaunchOutput.executionId !== "string"
  ) {
    throw new Error("exact PE-A live Build launch did not succeed");
  }
  const successfulResult = (call: ObservedToolCallV1 | undefined): boolean =>
    call !== undefined &&
    transcript.toolResults.some((result) => {
      const details = asRecord(result.details);
      return (
        result.toolCallId === call.id &&
        result.toolName === call.name &&
        !result.isError &&
        details?.outcome === "success"
      );
    });
  expect(successfulResult(exactLaunch)).toBe(true);
  const exactPin = transcript.toolCalls.find(
    (call) =>
      call.name === "game_capture_pin" &&
      call.arguments.runtimeId === runtimeIdentity.runtimeId &&
      asRecord(call.arguments.anchor)?.kind === "now" &&
      call.arguments.before === 0 &&
      call.arguments.after === 0,
  );
  expect(successfulResult(exactPin)).toBe(true);
  const exactPinResult = transcript.toolResults.find(
    (result) => result.toolCallId === exactPin?.id,
  );
  const exactPinOutput = asRecord(asRecord(exactPinResult?.details)?.output);
  if (typeof exactPinOutput?.captureWindowId !== "string") {
    throw new Error(
      "exact PE-A live Build pin did not return a capture window",
    );
  }
  const configureIndex = transcript.toolCalls.findIndex(
    (call) => call.name === "game_capture_configure",
  );
  const pinIndex = transcript.toolCalls.findIndex(
    (call) => call.id === exactPin?.id,
  );
  expect(configureIndex).toBeGreaterThanOrEqual(0);
  expect(pinIndex).toBeGreaterThan(configureIndex);
  const stateQueries = transcript.toolCalls.filter(
    (call) => call.name === "game_query" && call.arguments.select === "state",
  );
  expect(stateQueries.length).toBeGreaterThan(0);
  const entityQueries = transcript.toolCalls.filter(
    (call) =>
      call.name === "game_query" && call.arguments.select === "entities",
  );
  expect(entityQueries.some((call) => successfulResult(call))).toBe(true);
  expect(
    stateQueries.some((call) =>
      transcript.toolResults.some((result) => {
        const details = asRecord(result.details);
        return (
          result.toolCallId === call.id &&
          result.toolName === call.name &&
          !result.isError &&
          details?.outcome === "success" &&
          JSON.stringify(details).includes(`\"counter\":${expectedCounter}`)
        );
      }),
    ),
  ).toBe(true);
  for (const requiredName of [
    "game_capabilities",
    "game_capture_configure",
    "game_capture_pin",
    "game_stop",
  ]) {
    const calls = transcript.toolCalls.filter(
      (call) => call.name === requiredName,
    );
    if (!calls.some((call) => successfulResult(call))) {
      throw new Error(
        `PE-A live required tool did not succeed: ${JSON.stringify({
          requiredName,
          attempts: calls.map((call) => {
            const result = transcript.toolResults.find(
              (candidate) => candidate.toolCallId === call.id,
            );
            const details = asRecord(result?.details);
            const error = asRecord(details?.error);
            return {
              resultPresent: result !== undefined,
              isError: result?.isError ?? null,
              outcome:
                typeof details?.outcome === "string" ? details.outcome : null,
              errorCode: typeof error?.code === "string" ? error.code : null,
            };
          }),
        })}`,
      );
    }
  }
  return exactPinOutput.captureWindowId;
};

const openTaskStore = async (
  result: ProjectEnvironmentPreviewResultV1,
): Promise<ProjectEnvironmentTaskStoreV1> => {
  const taskStore = new ProjectEnvironmentTaskStoreV1({
    storeRoot: join(result.taskDirectory, "project-environment-records"),
    taskId: asProjectEnvironmentTaskId(result.taskId),
  });
  await taskStore.open();
  return taskStore;
};

const expectCompatibleBuild = async (
  taskStore: ProjectEnvironmentTaskStoreV1,
  result: ProjectEnvironmentPreviewResultV1,
): Promise<CompatibleBuildEvidenceV1> => {
  if (result.buildId === null) {
    throw new Error("ready PE-A live Preview omitted its exact Build ID");
  }
  const buildId = asBuildId(result.buildId);
  const [build, binding] = await Promise.all([
    taskStore.readBuild(buildId),
    taskStore.readBuildBinding(buildId),
  ]);
  expect(build.taskId).toBe(result.taskId);
  expect(binding).toMatchObject({
    schemaVersion: 1,
    taskId: result.taskId,
    buildId,
    compatibilityStatus: "compatible",
  });
  expect(binding.compatibilityReceiptId).not.toBeNull();
  if (binding.compatibilityReceiptId === null) {
    throw new Error("compatible PE-A live Build omitted its receipt ID");
  }
  const compatibility = await taskStore.readCompatibilityReceipt(
    binding.compatibilityReceiptId,
  );
  expect(compatibility).toMatchObject({
    schemaVersion: 1,
    taskId: result.taskId,
    buildId,
    environmentRevisionId: result.environmentRevisionId,
    adapterRevisionId: result.adapterRevisionId,
    bridgeHandshakeObserved: true,
    instrumentedLaunchObserved: true,
    outcome: "compatible",
    failures: [],
  });
  expect(compatibility.queryObservations).toMatchObject({
    schemaVersion: 1,
    entityQueryObserved: true,
    stateQueryObserved: true,
  });
  expect(compatibility.queryObservations.entityRows).toBeGreaterThan(0);
  expect(compatibility.queryObservations.stateRows).toBeGreaterThan(0);
  expect(compatibility.coverage.length).toBeGreaterThan(0);
  expect(
    compatibility.coverage.every(
      (entry) =>
        entry.status === "complete" &&
        entry.observedRecords > 0 &&
        entry.droppedRecords === 0 &&
        entry.overwrittenRecords === 0,
    ),
  ).toBe(true);
  expect(projectRuntimeCleanupCompleteV1(compatibility.cleanup)).toBe(true);
  return Object.freeze({ build, binding, compatibility });
};

const readFinalRuntimeObservation = async (
  taskStore: ProjectEnvironmentTaskStoreV1,
  result: ProjectEnvironmentPreviewResultV1,
) => {
  const receiptId = ProjectEnvironmentRuntimeObservationReceiptIdSchema.parse(
    result.runtimeObservationReceiptId,
  );
  const observation = await taskStore.readRuntimeObservationReceipt(receiptId);
  expect(observation).toMatchObject({
    schemaVersion: 1,
    receiptId,
    taskId: result.taskId,
    buildId: result.buildId,
    environmentRevisionId: result.environmentRevisionId,
    adapterRevisionId: result.adapterRevisionId,
    instrumentationMode: "instrumented",
    status: "stopped",
    outcome: "succeeded",
    failures: [],
    loss: [],
  });
  expect(observation.bridgeHandshakeCount).toBeGreaterThan(0);
  expect(observation.queryObservations.entityQueryCount).toBeGreaterThan(0);
  expect(observation.queryObservations.entityRows).toBeGreaterThan(0);
  expect(observation.queryObservations.stateQueryCount).toBeGreaterThan(0);
  expect(observation.queryObservations.stateRows).toBeGreaterThan(0);
  expect(observation.captureCount).toBeGreaterThan(0);
  expect(observation.coverage.length).toBeGreaterThan(0);
  expect(
    observation.coverage.every(
      (entry) =>
        entry.status === "complete" &&
        entry.observedRecords > 0 &&
        entry.droppedRecords === 0 &&
        entry.overwrittenRecords === 0 &&
        entry.limitations.length === 0,
    ),
  ).toBe(true);
  expect(projectRuntimeCleanupCompleteV1(observation.cleanup)).toBe(true);
  return observation;
};

const writeAndValidateEvidence = async (input: {
  readonly outputDirectory: string;
  readonly source: Awaited<
    ReturnType<typeof preflightCleanProjectEnvironmentV1>
  >;
  readonly projectStore: ProjectEnvironmentStoreV1;
  readonly initializationAttempt: Awaited<
    ReturnType<ProjectEnvironmentTaskStoreV1["readInitializationAttempt"]>
  >;
  readonly first: {
    readonly result: ProjectEnvironmentPreviewResultV1;
    readonly taskStore: ProjectEnvironmentTaskStoreV1;
    readonly binding: Extract<
      Awaited<
        ReturnType<ProjectEnvironmentTaskStoreV1["readBindingEpochs"]>
      >[number],
      { readonly state: "bound" }
    >;
    readonly publication: Awaited<
      ReturnType<ProjectEnvironmentTaskStoreV1["readPublicationReceipt"]>
    >;
    readonly turns: Awaited<
      ReturnType<ProjectEnvironmentTaskStoreV1["readTurns"]>
    >;
    readonly runtime: Awaited<
      ReturnType<ProjectEnvironmentTaskStoreV1["readRuntimeObservationReceipt"]>
    >;
    readonly compatible: CompatibleBuildEvidenceV1;
  };
  readonly reuse: {
    readonly result: ProjectEnvironmentPreviewResultV1;
    readonly taskStore: ProjectEnvironmentTaskStoreV1;
    readonly binding: Extract<
      Awaited<
        ReturnType<ProjectEnvironmentTaskStoreV1["readBindingEpochs"]>
      >[number],
      { readonly state: "reused" }
    >;
    readonly receipt: Awaited<
      ReturnType<ProjectEnvironmentTaskStoreV1["readReuseReceipt"]>
    >;
    readonly turns: Awaited<
      ReturnType<ProjectEnvironmentTaskStoreV1["readTurns"]>
    >;
    readonly runtime: Awaited<
      ReturnType<ProjectEnvironmentTaskStoreV1["readRuntimeObservationReceipt"]>
    >;
    readonly compatible: CompatibleBuildEvidenceV1;
  };
}): Promise<void> => {
  const current = await input.projectStore.readCurrent();
  if (
    current === null ||
    current.environmentRevisionId !== input.first.result.environmentRevisionId
  ) {
    throw new Error("PE-A live evidence lost its current Project revision");
  }
  const storedRevision = await input.projectStore.readRevision(
    current.environmentRevisionId,
    current.publicationOperationId,
  );
  const adapterFiles = storedRevision.files
    .filter((file) => file.path.startsWith("adapter/"))
    .map((file) => ({
      path: file.path.slice("adapter/".length),
      bytes: file.bytes,
    }));
  const loadedAdapter = loadProjectAdapterPackageFilesV1(adapterFiles, {
    requireSingleLaunchTarget: true,
    expectedMainScene: input.source.mainScene,
    requireEmptyLaunchParameters: true,
  });
  const inspected = inspectReusableProjectEnvironmentRevisionV1({
    revision: storedRevision.payload,
    files: storedRevision.files,
    expectedSourceId: storedRevision.payload.sourceId,
    expectedToolchainReceiptId: storedRevision.payload.toolchainReceiptId,
    expectedAdapterId: asAdapterId(loadedAdapter.manifest.adapterId),
    expectedMainScene: input.source.mainScene,
  });
  const [candidateFiles, reuseCandidateFiles] = await Promise.all([
    collectCandidateGodotSourceV1(
      join(input.first.result.taskDirectory, "workspace"),
      "project-environment",
    ),
    collectCandidateGodotSourceV1(
      join(input.reuse.result.taskDirectory, "workspace"),
      "project-environment",
    ),
  ]);
  const [toolchain, reuseToolchain, pinnedCaptures, reusePinnedCaptures] =
    await Promise.all([
      input.first.taskStore.readToolchainReceipt(
        storedRevision.payload.toolchainReceiptId,
      ),
      input.reuse.taskStore.readToolchainReceipt(
        storedRevision.payload.toolchainReceiptId,
      ),
      Promise.all(
        input.first.runtime.captureWindowIds.map((captureWindowId) =>
          input.first.taskStore.readPinnedCapture(captureWindowId),
        ),
      ),
      Promise.all(
        input.reuse.runtime.captureWindowIds.map((captureWindowId) =>
          input.reuse.taskStore.readPinnedCapture(captureWindowId),
        ),
      ),
    ]);
  const [taskInventory, reuseTaskInventory] = await Promise.all([
    input.first.taskStore.freezeEvidenceInventory(),
    input.reuse.taskStore.freezeEvidenceInventory(),
  ]);
  const evidence = buildProjectEnvironmentPeAEvidenceV1({
    source: input.source,
    loadedAdapter,
    adapterRevision: inspected.adapterRevision,
    toolchain,
    environmentRevision: storedRevision.payload,
    revisionFiles: storedRevision.files,
    revisionPackage: {
      payloadHash: storedRevision.payloadHash,
      packageHash: storedRevision.packageHash,
      packageSeal: storedRevision.packageSeal,
    },
    publication: input.first.publication,
    initializationAttempt: input.initializationAttempt,
    taskInventory,
    environmentBinding: input.first.binding,
    preparedBuild: {
      build: input.first.compatible.build,
      binding: {
        ...input.first.compatible.binding,
        compatibilityStatus: "pending",
        compatibilityReceiptId: null,
      },
      configuredMainScene: input.source.mainScene,
      projectHash: input.first.compatible.build.outputHash,
      fileCount: candidateFiles.length,
      byteLength: candidateFiles.reduce(
        (total, file) => total + file.content.byteLength,
        0,
      ),
    },
    finalBuildBinding: input.first.compatible.binding,
    compatibility: input.first.compatible.compatibility,
    turns: input.first.turns,
    runtime: input.first.runtime,
    pinnedCaptures,
    reuse: {
      toolchain: reuseToolchain,
      receipt: input.reuse.receipt,
      environmentBinding: input.reuse.binding,
      preparedBuild: {
        build: input.reuse.compatible.build,
        binding: {
          ...input.reuse.compatible.binding,
          compatibilityStatus: "pending",
          compatibilityReceiptId: null,
        },
        configuredMainScene: input.source.mainScene,
        projectHash: input.reuse.compatible.build.outputHash,
        fileCount: reuseCandidateFiles.length,
        byteLength: reuseCandidateFiles.reduce(
          (total, file) => total + file.content.byteLength,
          0,
        ),
      },
      finalBuildBinding: input.reuse.compatible.binding,
      compatibility: input.reuse.compatible.compatibility,
      turns: input.reuse.turns,
      runtime: input.reuse.runtime,
      pinnedCaptures: reusePinnedCaptures,
      taskInventory: reuseTaskInventory,
      goalDelivered: input.reuse.result.goalDelivered,
    },
    goalDelivered: input.first.result.goalDelivered,
  });
  const evidencePath = join(input.outputDirectory, "pe-a-evidence.v1.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  const validated = await execFileAsync(
    process.execPath,
    [EVIDENCE_VALIDATOR, EVIDENCE_SCHEMA, evidencePath],
    {
      cwd: process.cwd(),
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  expect(validated.stderr).toBe("");
  expect(JSON.parse(validated.stdout)).toMatchObject({
    schemaVersion: 1,
    bundleContentHash: evidence.bundleContentHash,
    environmentRevisionId: input.first.result.environmentRevisionId,
    buildId: input.first.result.buildId,
    compatibilityReceiptId: input.first.compatible.compatibility.receiptId,
  });
};

describe("PE-A real Pi Project Environment live Gate", () => {
  it.skipIf(!LIVE_GATE_ENABLED)(
    "initializes in one visible Session, observes a changed exact Build, then reuses the published adapter in a new Session",
    { timeout: 2_400_000 },
    async () => {
      const provider = requiredIdentifierEnvironment(
        "CHRONORIFT_TEST_PE_A_PROVIDER",
      );
      const model = requiredIdentifierEnvironment("CHRONORIFT_TEST_PE_A_MODEL");
      const thinkingLevel = requestedThinkingLevel();
      const sourceHostConfigPath = requiredEnvironment(
        "CHRONORIFT_TEST_PE_A_HOST_CONFIG",
      );
      const agentDir = await requiredDirectoryEnvironment(
        "CHRONORIFT_TEST_PE_A_AGENT_DIR",
      );
      const evidenceOutputDirectory = await requiredDirectoryEnvironment(
        "CHRONORIFT_TEST_PE_A_EVIDENCE_OUTPUT_DIR",
      );
      const testRoot = await mkdtemp(join(tmpdir(), OWNED_RUNTIME_PREFIX));
      temporaryRoots.push(testRoot);
      const projectRoot = join(testRoot, "project");
      await initializeFixtureRepository(projectRoot);
      const host = await writeIsolatedHostConfig({
        testRoot,
        sourceConfigPath: sourceHostConfigPath,
      });
      const baseline = await preflightCleanProjectEnvironmentV1({
        projectPath: projectRoot,
        sourceRepositoryExclusionRoots: [host.config.taskStorageRoot],
      });
      const baselineMain = await readFile(join(projectRoot, "main.gd"), "utf8");

      const firstGoal = [
        "Continue in this same visible Pi Session and perform the requested project work; do not merely describe it.",
        "Edit only the game source main.gd so Main.counter starts at exactly 2 instead of 1. Do not modify or regenerate the published ProjectAdapter.",
        'After the edit, call game_capabilities so the Harness freezes and validates the current exact Build. Use the returned buildId and declared default launch target to launch that Build. Configure bounded capture with game_capture_configure using channels ["entity","state","event","runtime_error"], retention {clockDomain:"process_frame",before:0,after:0}, sampling:[], and triggers:[]. Durably pin one current batch with game_capture_pin using anchor kind now and before = after = 0, query both nonempty entities and state observations until the project state contains counter = 2, then stop the runtime.',
        "Report only the source edit and game observations you actually made.",
      ].join("\n");
      const first = await runProjectEnvironmentPreviewV1({
        projectPath: projectRoot,
        provider,
        model,
        thinkingLevel,
        goal: firstGoal,
        hostConfigPath: host.path,
        agentDir,
        timeoutMs: TURN_TIMEOUT_MS,
      });

      if (first.status !== "ready") {
        throw new Error(
          `PE-A live first Preview failed: ${JSON.stringify({
            status: first.status,
            failureCode: first.failureCode,
            failureMessage: first.failureMessage,
          })}`,
        );
      }

      expect(first).toMatchObject({
        schemaVersion: 1,
        status: "ready",
        provider,
        model,
        thinkingLevel,
        reused: false,
        goalDelivered: true,
        candidateSourceChanged: true,
      });
      expect(first.environmentRevisionId).not.toBeNull();
      expect(first.adapterRevisionId).not.toBeNull();
      expect(first.buildId).not.toBeNull();
      expect(first.runtimeObservationReceiptId).not.toBeNull();
      const firstTaskStore = await openTaskStore(first);
      const [firstEvents, firstBindings, firstTurns, firstSummary] =
        await Promise.all([
          firstTaskStore.readAttemptEvents(),
          firstTaskStore.readBindingEpochs(),
          firstTaskStore.readTurns(),
          firstTaskStore.summary(),
        ]);
      expect(firstEvents.map((event) => event.eventKind)).toEqual([
        "created",
        "agent_running",
        "candidate_frozen",
        "validating",
        "publishing",
        "publication_committed",
        "binding",
        "succeeded",
      ]);
      expect(firstEvents.map((event) => event.sequence)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7,
      ]);
      expect(new Set(firstEvents.map((event) => event.taskId))).toEqual(
        new Set([first.taskId]),
      );
      expect(firstBindings).toHaveLength(1);
      expect(firstBindings[0]).toMatchObject({
        schemaVersion: 1,
        taskId: first.taskId,
        state: "bound",
      });
      expect(firstTurns.map((turn) => turn.purpose)).toEqual([
        "environment_initialization",
        "user_goal",
      ]);
      expect(firstTurns.map((turn) => turn.status)).toEqual([
        "completed",
        "completed",
      ]);
      expect(new Set(firstTurns.map((turn) => turn.sessionId))).toEqual(
        new Set([first.sessionId]),
      );
      expect(firstTurns[0]?.attemptId).not.toBeNull();
      expect(firstTurns[0]?.bindingEpochId).toBeNull();
      expect(firstTurns[1]?.attemptId).toBeNull();
      expect(firstTurns[1]?.bindingEpochId).toBe(
        firstBindings[0]?.bindingEpochId,
      );
      expect(firstSummary.candidates).toBe(1);
      expect(firstSummary.captureWindows).toBe(1);
      const created = firstEvents[0];
      if (created?.eventKind !== "created") {
        throw new Error(
          "PE-A live initialization did not retain its creation event",
        );
      }
      const attempt = await firstTaskStore.readInitializationAttempt(
        created.attemptId,
      );
      expect(attempt).toMatchObject({
        schemaVersion: 1,
        taskId: first.taskId,
        sessionId: first.sessionId,
        providerId: provider,
        modelId: model,
        thinkingLevel,
        state: "succeeded",
        eventCount: 8,
      });
      const firstBinding = firstBindings[0];
      if (firstBinding?.state !== "bound") {
        throw new Error("PE-A live initial binding receipt is missing");
      }
      const publication = await firstTaskStore.readPublicationReceipt(
        firstBinding.publicationReceiptId,
      );
      expect(publication).toMatchObject({
        schemaVersion: 1,
        taskId: first.taskId,
        outcome: "committed",
        targetEnvironmentRevisionId: first.environmentRevisionId,
      });
      const firstCompatible = await expectCompatibleBuild(
        firstTaskStore,
        first,
      );
      expect(firstCompatible.build.sourceHash).not.toBe(
        baseline.selectedTreeSha256,
      );
      expect(
        await readFile(join(first.taskDirectory, "workspace/main.gd"), "utf8"),
      ).toContain("var counter := 2");
      expect(
        await git(join(first.taskDirectory, "workspace"), [
          "diff",
          "--name-only",
          "--",
        ]),
      ).toBe("main.gd\n");
      const firstTranscript = await readSessionTranscript(
        requireSessionFile(first),
      );
      expect(firstTranscript.header).toMatchObject({
        type: "session",
        id: first.sessionId,
        cwd: "/workspace",
      });
      expect(firstTranscript.userMessageCount).toBe(2);
      const firstRuntime = await readFinalRuntimeObservation(
        firstTaskStore,
        first,
      );
      const firstCaptureWindowId = assertObservedExactBuild(
        firstTranscript,
        first.buildId!,
        2,
        firstRuntime,
      );
      await expect(
        firstTaskStore.readPinnedCapture(
          CaptureWindowIdSchema.parse(firstCaptureWindowId),
        ),
      ).resolves.toMatchObject({
        payload: {
          captureWindowId: firstCaptureWindowId,
          taskId: first.taskId,
          runtimeId: firstRuntime.runtimeId,
          executionId: firstRuntime.executionId,
          buildId: first.buildId,
        },
      });
      const secondGoal = [
        "Work directly with the already initialized Project Environment. Do not create or regenerate an adapter and do not edit project source.",
        'Call game_capabilities and launch its exact compatible build with the declared default target. Configure bounded capture with game_capture_configure using channels ["entity","state","event","runtime_error"], retention {clockDomain:"process_frame",before:0,after:0}, sampling:[], and triggers:[]. Durably pin one current batch with game_capture_pin using anchor kind now and before = after = 0, query both nonempty entities and state observations until counter = 1 is observed, and stop the runtime. Report only actual observations.',
      ].join("\n");
      const second = await runProjectEnvironmentPreviewV1({
        projectPath: projectRoot,
        provider,
        model,
        thinkingLevel,
        goal: secondGoal,
        hostConfigPath: host.path,
        agentDir,
        timeoutMs: TURN_TIMEOUT_MS,
      });

      expect(second).toMatchObject({
        schemaVersion: 1,
        status: "ready",
        provider,
        model,
        thinkingLevel,
        environmentId: first.environmentId,
        environmentRevisionId: first.environmentRevisionId,
        adapterRevisionId: first.adapterRevisionId,
        reused: true,
        goalDelivered: true,
        candidateSourceChanged: false,
      });
      expect(second.taskId).not.toBe(first.taskId);
      expect(second.sessionId).not.toBe(first.sessionId);
      expect(second.buildId).not.toBeNull();
      expect(second.runtimeObservationReceiptId).not.toBeNull();
      const secondTaskStore = await openTaskStore(second);
      const [secondEvents, secondBindings, secondTurns, secondSummary] =
        await Promise.all([
          secondTaskStore.readAttemptEvents(),
          secondTaskStore.readBindingEpochs(),
          secondTaskStore.readTurns(),
          secondTaskStore.summary(),
        ]);
      expect(secondEvents).toEqual([]);
      expect(secondSummary.candidates).toBe(0);
      expect(secondSummary.captureWindows).toBe(1);
      expect(secondBindings).toHaveLength(1);
      expect(secondBindings[0]).toMatchObject({
        schemaVersion: 1,
        taskId: second.taskId,
        state: "reused",
        sessionId: second.sessionId,
      });
      expect(secondTurns).toHaveLength(1);
      expect(secondTurns[0]).toMatchObject({
        schemaVersion: 1,
        taskId: second.taskId,
        sessionId: second.sessionId,
        purpose: "user_goal",
        attemptId: null,
        status: "completed",
      });
      expect(secondTurns[0]?.bindingEpochId).toBe(
        secondBindings[0]?.bindingEpochId,
      );
      const secondBinding = secondBindings[0];
      if (secondBinding?.state !== "reused") {
        throw new Error("PE-A live reuse binding receipt is missing");
      }
      const reuse = await secondTaskStore.readReuseReceipt(
        secondBinding.reuseReceiptId,
      );
      expect(reuse).toMatchObject({
        schemaVersion: 1,
        taskId: second.taskId,
        sessionId: second.sessionId,
        environmentRevisionId: first.environmentRevisionId,
        adapterRevisionId: first.adapterRevisionId,
        observedCurrentRevisionId: first.environmentRevisionId,
        schemaBindingValidated: true,
        adapterPackageValidated: true,
        quickSmokeCompatible: true,
        outcome: "reused",
        failures: [],
      });
      expect(projectRuntimeCleanupCompleteV1(reuse.cleanup)).toBe(true);
      const secondCompatible = await expectCompatibleBuild(
        secondTaskStore,
        second,
      );
      expect(secondCompatible.compatibility.receiptId).toBe(
        secondBinding.compatibilityReceiptId,
      );
      const secondTranscript = await readSessionTranscript(
        requireSessionFile(second),
      );
      expect(secondTranscript.header).toMatchObject({
        type: "session",
        id: second.sessionId,
        cwd: "/workspace",
      });
      expect(secondTranscript.userMessageCount).toBe(1);
      const secondRuntime = await readFinalRuntimeObservation(
        secondTaskStore,
        second,
      );
      const secondCaptureWindowId = assertObservedExactBuild(
        secondTranscript,
        second.buildId!,
        1,
        secondRuntime,
      );
      await expect(
        secondTaskStore.readPinnedCapture(
          CaptureWindowIdSchema.parse(secondCaptureWindowId),
        ),
      ).resolves.toMatchObject({
        payload: {
          captureWindowId: secondCaptureWindowId,
          taskId: second.taskId,
          runtimeId: secondRuntime.runtimeId,
          executionId: secondRuntime.executionId,
          buildId: second.buildId,
        },
      });
      expect(
        await git(join(second.taskDirectory, "workspace"), [
          "diff",
          "--name-only",
          "--",
        ]),
      ).toBe("");

      const projectStore = new ProjectEnvironmentStoreV1({
        namespaceRoot: first.projectNamespace,
        environmentId: asProjectEnvironmentId(first.environmentId),
      });
      await projectStore.open();
      await writeAndValidateEvidence({
        outputDirectory: evidenceOutputDirectory,
        source: baseline,
        projectStore,
        initializationAttempt: attempt,
        first: {
          result: first,
          taskStore: firstTaskStore,
          binding: firstBinding,
          publication,
          turns: firstTurns,
          runtime: firstRuntime,
          compatible: firstCompatible,
        },
        reuse: {
          result: second,
          taskStore: secondTaskStore,
          binding: secondBinding,
          receipt: reuse,
          turns: secondTurns,
          runtime: secondRuntime,
          compatible: secondCompatible,
        },
      });
      const projectSummary = await projectStore.summary();
      expect(projectSummary).toMatchObject({
        schemaVersion: 1,
        environmentId: first.environmentId,
        completeRevisions: 1,
        incompleteRevisions: 0,
        quarantinedRevisions: 0,
      });
      expect(projectSummary.current).toMatchObject({
        schemaVersion: 1,
        environmentId: first.environmentId,
        environmentRevisionId: first.environmentRevisionId,
      });
      expect(await readFile(join(projectRoot, "main.gd"), "utf8")).toBe(
        baselineMain,
      );
      expect(await git(projectRoot, ["status", "--porcelain=v1"])).toBe("");
    },
  );
});
