import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  asAdapterId,
  asBuildId,
  asProjectEnvironmentId,
  asProjectEnvironmentRuntimeObservationReceiptId,
  asProjectEnvironmentTaskId,
} from "@chronorift/domain";
import { loadProjectAdapterPackageFilesV2 } from "@chronorift/godot-adapter";
import {
  ProjectEnvironmentStoreV1,
  ProjectEnvironmentTaskStoreV1,
} from "@chronorift/json-artifacts";
import {
  runVNextPiTurnWithSdk,
  type PiThinkingLevel,
} from "@chronorift/pi-harness";
import { afterEach, describe, expect, it } from "vitest";

import {
  readProjectEnvironmentHostConfigV1,
  type ProjectEnvironmentHostConfigV1,
} from "./project-environment-host-config.js";
import { buildProjectEnvironmentPeBEvidenceV2 } from "./project-environment-pe-b-evidence.js";
import {
  runProjectEnvironmentPreviewV1,
  type ProjectEnvironmentPreviewResultV1,
} from "./project-environment-preview.js";
import { inspectReusableProjectEnvironmentRevisionV2 } from "./project-environment-reuse-v2.js";
import { preflightCleanProjectEnvironmentV1 } from "./source-preflight.js";

const execFileAsync = promisify(execFile);
const ENABLED = process.env.CHRONORIFT_TEST_PE_B_LIVE === "1";
const TURN_TIMEOUT_MS = 600_000;
const OWNED_PREFIX = "chronorift-pe-b-live-";
const temporaryRoots: string[] = [];
const ownedRuntimeRoots: { taskStorageRoot: string; runtimeRoot: string }[] =
  [];
const thinkingLevels = new Set<PiThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const runPiTurnWithProgress: typeof runVNextPiTurnWithSdk = async (options) => {
  const startedAt = Date.now();
  const phase = options.loadProjectAdapterSkillV2 ? "initialization" : "goal";
  const progress = (event: {
    readonly type: string;
    readonly toolName?: string;
    readonly isError?: boolean;
  }): void => {
    if (
      event.type !== "tool_execution_start" &&
      event.type !== "tool_execution_end" &&
      event.type !== "turn_start" &&
      event.type !== "turn_end" &&
      event.type !== "auto_retry_start" &&
      event.type !== "auto_retry_end" &&
      event.type !== "compaction_start" &&
      event.type !== "compaction_end"
    )
      return;
    process.stderr.write(
      `${JSON.stringify({
        gate: "project-environment-pe-b-live",
        phase,
        elapsedMs: Date.now() - startedAt,
        event: event.type,
        ...(event.toolName === undefined ? {} : { tool: event.toolName }),
        ...(event.isError === undefined ? {} : { isError: event.isError }),
      })}\n`,
    );
  };
  return runVNextPiTurnWithSdk({ ...options, onEvent: progress });
};

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.trim() === "" || value.includes("\0"))
    throw new Error(`PE-B live Gate requires ${name}`);
  return value;
};
const requiredDirectory = async (name: string): Promise<string> => {
  const requested = resolve(required(name));
  const canonical = await realpath(requested);
  if (canonical !== requested || !(await stat(canonical)).isDirectory())
    throw new Error(`PE-B live Gate requires canonical directory ${name}`);
  return canonical;
};
const git = async (cwd: string, args: readonly string[]): Promise<string> =>
  (
    await execFileAsync("/usr/bin/git", [...args], {
      cwd,
      env: {
        PATH: "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
        HOME: cwd,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "ChronoRift PE-B Live",
        GIT_AUTHOR_EMAIL: "pe-b-live@chronorift.invalid",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_NAME: "ChronoRift PE-B Live",
        GIT_COMMITTER_EMAIL: "pe-b-live@chronorift.invalid",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
  ).stdout;

afterEach(async () => {
  await Promise.all([
    ...temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
    ...ownedRuntimeRoots
      .splice(0)
      .map(async ({ taskStorageRoot, runtimeRoot }) => {
        if (
          dirname(runtimeRoot) !== taskStorageRoot ||
          !basename(runtimeRoot).startsWith(OWNED_PREFIX)
        )
          throw new Error("refusing to remove a non-owned PE-B runtime root");
        await rm(runtimeRoot, { recursive: true, force: true });
      }),
  ]);
});

const initializeFixture = async (projectRoot: string): Promise<void> => {
  const fixture = await realpath(
    join(process.cwd(), "fixtures/godot-project-environment-dynamic"),
  );
  await mkdir(projectRoot);
  await cp(fixture, projectRoot, { recursive: true });
  await git(projectRoot, ["init", "--quiet", "--initial-branch=main"]);
  await git(projectRoot, ["add", "--all"]);
  await git(projectRoot, ["commit", "--quiet", "-m", "frozen PE-B fixture"]);
  expect(await git(projectRoot, ["status", "--porcelain=v1"])).toBe("");
};

const isolatedHost = async (
  testRoot: string,
  sourcePath: string,
): Promise<{ config: ProjectEnvironmentHostConfigV1; path: string }> => {
  const source = await readProjectEnvironmentHostConfigV1(
    await realpath(sourcePath),
  );
  const runtimeRoot = join(
    source.taskStorageRoot,
    `${OWNED_PREFIX}${randomUUID()}`,
  );
  if (
    dirname(runtimeRoot) !== source.taskStorageRoot ||
    relative(source.taskStorageRoot, runtimeRoot).includes(sep)
  )
    throw new Error("PE-B runtime root is not an owned direct child");
  const config = Object.freeze({ ...source, runtimeRoot });
  const path = join(testRoot, "host-config.v1.json");
  await writeFile(path, `${JSON.stringify(config)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  ownedRuntimeRoots.push({
    taskStorageRoot: source.taskStorageRoot,
    runtimeRoot,
  });
  return { config, path: await realpath(path) };
};

const openTaskStore = async (result: ProjectEnvironmentPreviewResultV1) => {
  const store = new ProjectEnvironmentTaskStoreV1({
    storeRoot: join(result.taskDirectory, "project-environment-records"),
    taskId: asProjectEnvironmentTaskId(result.taskId),
  });
  await store.open();
  return store;
};

describe("PE-B real Pi dynamic Project Environment Gate", () => {
  it.skipIf(!ENABLED)(
    "authors V2, observes one dynamic trace, then reuses it in a new Session",
    { timeout: 2_400_000 },
    async () => {
      const provider = required("CHRONORIFT_TEST_PE_B_PROVIDER");
      const model = required("CHRONORIFT_TEST_PE_B_MODEL");
      const thinking = required("CHRONORIFT_TEST_PE_B_THINKING_LEVEL");
      if (!thinkingLevels.has(thinking as PiThinkingLevel))
        throw new Error("PE-B thinking level is unsupported");
      const agentDir = await requiredDirectory(
        "CHRONORIFT_TEST_PE_B_AGENT_DIR",
      );
      const evidenceDirectory = await requiredDirectory(
        "CHRONORIFT_TEST_PE_B_EVIDENCE_OUTPUT_DIR",
      );
      const root = await mkdtemp(join(tmpdir(), OWNED_PREFIX));
      temporaryRoots.push(root);
      const projectRoot = join(root, "project");
      await initializeFixture(projectRoot);
      const host = await isolatedHost(
        root,
        required("CHRONORIFT_TEST_PE_B_HOST_CONFIG"),
      );
      const source = await preflightCleanProjectEnvironmentV1({
        projectPath: projectRoot,
        sourceRepositoryExclusionRoots: [host.config.taskStorageRoot],
      });
      const goal = [
        "Use the already initialized Project Environment; do not edit project source or regenerate the adapter.",
        "Call game_capabilities, launch its exact build and main target, configure capture with channels entity/state/event/runtime_error and zero process-frame retention, sampling and triggers empty.",
        "Query nonempty entities, state, and events; durably pin the current lossless capture using anchor now and before/after 0; then stop the runtime.",
        "Explain only the observed create/state/event/change/destroy/recreate lineage, including the two incarnations. Do not claim Signal causality.",
        "Before stop, call game_status and read its PE-B stop readiness limitation. If it is incomplete, perform exactly the missing query or pin on that same runtime, then check status again. Call stop only when readiness says complete.",
        "After one successful stop, finish immediately. Do not relaunch, inspect files, run shell commands, or call game tools again.",
      ].join("\n");
      const request = {
        projectPath: projectRoot,
        provider,
        model,
        thinkingLevel: thinking as PiThinkingLevel,
        goal,
        hostConfigPath: host.path,
        agentDir,
        timeoutMs: TURN_TIMEOUT_MS,
      } as const;
      const first = await runProjectEnvironmentPreviewV1(request, {
        runPiTurn: runPiTurnWithProgress,
      });
      if (first.status !== "ready")
        throw new Error(
          `PE-B first Preview failed: ${first.failureCode}: ${first.failureMessage}`,
        );
      const second = await runProjectEnvironmentPreviewV1(request, {
        runPiTurn: runPiTurnWithProgress,
      });
      if (second.status !== "ready")
        throw new Error(
          `PE-B reuse Preview failed: ${second.failureCode}: ${second.failureMessage}`,
        );
      expect(first).toMatchObject({
        reused: false,
        goalDelivered: true,
        candidateSourceChanged: false,
        provider,
        model,
        thinkingLevel: thinking,
      });
      expect(second).toMatchObject({
        reused: true,
        goalDelivered: true,
        candidateSourceChanged: false,
        environmentRevisionId: first.environmentRevisionId,
        adapterRevisionId: first.adapterRevisionId,
      });
      expect(second.taskId).not.toBe(first.taskId);
      expect(second.sessionId).not.toBe(first.sessionId);
      expect(await git(projectRoot, ["status", "--porcelain=v1"])).toBe("");

      const firstStore = await openTaskStore(first);
      const secondStore = await openTaskStore(second);
      const [firstBindings, secondBindings, firstTurns, secondTurns, events] =
        await Promise.all([
          firstStore.readBindingEpochs(),
          secondStore.readBindingEpochs(),
          firstStore.readTurns(),
          secondStore.readTurns(),
          firstStore.readAttemptEvents(),
        ]);
      const firstBinding = firstBindings[0];
      const secondBinding = secondBindings[0];
      const created = events[0];
      if (
        firstBinding?.state !== "bound" ||
        secondBinding?.state !== "reused" ||
        created?.eventKind !== "created"
      )
        throw new Error("PE-B live Gate omitted publication/reuse bindings");
      const [attempt, publication, reuseReceipt] = await Promise.all([
        firstStore.readInitializationAttempt(created.attemptId),
        firstStore.readPublicationReceipt(firstBinding.publicationReceiptId),
        secondStore.readReuseReceipt(secondBinding.reuseReceiptId),
      ]);
      if (
        first.buildId === null ||
        second.buildId === null ||
        first.runtimeObservationReceiptId === null ||
        second.runtimeObservationReceiptId === null
      )
        throw new Error("PE-B live Gate omitted Build/runtime IDs");
      const [
        firstBuildBinding,
        secondBuildBinding,
        firstRuntime,
        secondRuntime,
      ] = await Promise.all([
        firstStore.readBuildBinding(asBuildId(first.buildId)),
        secondStore.readBuildBinding(asBuildId(second.buildId)),
        firstStore.readRuntimeObservationReceiptV2(
          asProjectEnvironmentRuntimeObservationReceiptId(
            first.runtimeObservationReceiptId,
          ),
        ),
        secondStore.readRuntimeObservationReceiptV2(
          asProjectEnvironmentRuntimeObservationReceiptId(
            second.runtimeObservationReceiptId,
          ),
        ),
      ]);
      if (
        firstBuildBinding.compatibilityReceiptId === null ||
        secondBuildBinding.compatibilityReceiptId === null ||
        firstRuntime.captureWindowIds[0] === undefined ||
        secondRuntime.captureWindowIds[0] === undefined
      )
        throw new Error("PE-B live Gate omitted compatibility/capture IDs");
      const [
        firstCompatibility,
        secondCompatibility,
        firstCapture,
        secondCapture,
      ] = await Promise.all([
        firstStore.readCompatibilityReceiptV2(
          firstBuildBinding.compatibilityReceiptId,
        ),
        secondStore.readCompatibilityReceiptV2(
          secondBuildBinding.compatibilityReceiptId,
        ),
        firstStore.readPinnedCapture(firstRuntime.captureWindowIds[0]),
        secondStore.readPinnedCapture(secondRuntime.captureWindowIds[0]),
      ]);
      expect(firstRuntime.dynamicTraces[0]).toMatchObject({
        firstIncarnation: 1,
        lastIncarnation: 2,
      });
      expect(secondRuntime.dynamicTraces[0]).toMatchObject({
        firstIncarnation: 1,
        lastIncarnation: 2,
      });
      expect(firstRuntime.executionId).not.toBe(secondRuntime.executionId);

      const projectStore = new ProjectEnvironmentStoreV1({
        namespaceRoot: first.projectNamespace,
        environmentId: asProjectEnvironmentId(first.environmentId),
      });
      await projectStore.open();
      const current = await projectStore.readCurrent();
      if (current === null)
        throw new Error("PE-B live Gate omitted current revision");
      const revision = await projectStore.readRevision(
        current.environmentRevisionId,
        current.publicationOperationId,
      );
      const loaded = loadProjectAdapterPackageFilesV2(
        revision.files
          .filter((file) => file.path.startsWith("adapter/"))
          .map((file) => ({ path: file.path.slice(8), bytes: file.bytes })),
        {
          requireSingleLaunchTarget: true,
          expectedMainScene: source.mainScene,
          requireEmptyLaunchParameters: true,
        },
      );
      inspectReusableProjectEnvironmentRevisionV2({
        revision: revision.payload,
        files: revision.files,
        expectedSourceId: revision.payload.sourceId,
        expectedToolchainReceiptId: revision.payload.toolchainReceiptId,
        expectedAdapterId: asAdapterId(loaded.manifest.adapterId),
        expectedMainScene: source.mainScene,
      });
      const evidence = buildProjectEnvironmentPeBEvidenceV2({
        source,
        loadedAdapter: loaded,
        environmentRevision: revision.payload,
        revisionFiles: revision.files,
        revisionPayloadHash: revision.payloadHash,
        revisionPackageHash: revision.packageHash,
        revisionPackageSeal: revision.packageSeal,
        publication,
        initializationAttempt: attempt,
        toolchain: await firstStore.readToolchainReceipt(
          revision.payload.toolchainReceiptId,
        ),
        first: {
          taskId: first.taskId,
          sessionId: first.sessionId,
          binding: firstBinding,
          compatibility: firstCompatibility,
          runtime: firstRuntime,
          pinnedCapture: firstCapture,
          turns: firstTurns,
          goalDelivered: first.goalDelivered,
        },
        reuse: {
          taskId: second.taskId,
          sessionId: second.sessionId,
          binding: secondBinding,
          compatibility: secondCompatibility,
          runtime: secondRuntime,
          pinnedCapture: secondCapture,
          turns: secondTurns,
          goalDelivered: second.goalDelivered,
          reuseReceipt,
        },
      });
      const evidencePath = join(evidenceDirectory, "pe-b-evidence.v2.json");
      await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      const validated = await execFileAsync(
        process.execPath,
        [
          resolve(
            ".github/scripts/validate-project-environment-pe-b-evidence.mjs",
          ),
          resolve(
            "testdata/vnext/project-environment/pe-b-evidence-bundle.schema.v2.json",
          ),
          evidencePath,
        ],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      );
      expect(validated.stderr).toBe("");
      expect(JSON.parse(validated.stdout)).toMatchObject({
        schemaVersion: 2,
        bundleContentHash: evidence.bundleContentHash,
        firstExecutionId: firstRuntime.executionId,
        reuseExecutionId: secondRuntime.executionId,
      });
    },
  );
});
